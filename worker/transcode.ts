import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'

import { db, videoVariants, videos } from '@/db'
import { env } from '@/lib/env'
import type { TranscodePayload } from '@/lib/jobs/queue'
import { getVideoProvider, paths } from '@/lib/video'
import { transcodeToHls } from '@/lib/video/pipeline'
import { ProbeError } from '@/lib/video/probe'

/**
 * One transcode job: fetch the source, build the ladder, upload the package,
 * publish the metadata.
 *
 * Every step is idempotent or cleans up after itself, because this job will be
 * retried — a worker can be killed mid-encode at any point and the reaper will
 * hand the same job to someone else.
 */

/** Raised for input that will never succeed, so the job goes straight to dead. */
export class PermanentTranscodeError extends Error {}

export async function runTranscode(
  payload: TranscodePayload,
  onProgress: (percent: number, stage: string) => void,
): Promise<void> {
  const provider = await getVideoProvider()
  const workDir = await mkdtemp(path.join(env.WORKER_TMP_DIR || tmpdir(), 'tx-'))

  try {
    const sourcePath = path.join(workDir, 'source')
    const outDir = path.join(workDir, 'hls')

    onProgress(1, 'download')
    await provider.downloadToFile(payload.objectKey, sourcePath)

    let result
    try {
      result = await transcodeToHls(sourcePath, outDir, (percent, stage) =>
        // Encoding occupies 5–75% of the job; upload takes the rest.
        onProgress(5 + percent * 0.7, stage),
      )
    } catch (error) {
      // A file that will not probe will not probe on the third attempt either.
      // Failing it permanently keeps a corrupt upload from burning three
      // multi-minute retries before anyone notices.
      if (error instanceof ProbeError) {
        throw new PermanentTranscodeError(error.message)
      }
      throw error
    }

    onProgress(76, 'upload')
    await provider.uploadDirectory({
      localDir: outDir,
      keyPrefix: paths.prefix(payload.videoId).replace(/\/$/, ''),
      onProgress: (done, total) => onProgress(76 + (done / total) * 22, 'upload'),
    })

    onProgress(98, 'publish')

    /**
     * Variants and video metadata are written together so a crash between them
     * cannot leave a video pointing at a ladder that was never recorded.
     *
     * Variants are deleted first rather than upserted: a retry after a partial
     * run may have produced a different set of renditions (a different ladder,
     * a re-encode), and leftovers from the previous attempt would end up in the
     * master playlist as variants that no longer exist.
     */
    await db.transaction(async (tx) => {
      await tx.delete(videoVariants).where(eq(videoVariants.videoId, payload.videoId))

      // The audio-only rendition is a real HLS variant but not a resolution
      // rung, and video_variants is keyed by (video_id, resolution).
      const videoOnly = result.variants.filter((v) => v.height > 0)

      if (videoOnly.length > 0) {
        await tx.insert(videoVariants).values(
          videoOnly.map((v) => ({
            videoId: payload.videoId,
            resolution: v.name,
            width: v.width,
            height: v.height,
            bitrateKbps: v.bitrateKbps,
            peakBitrateKbps: v.peakBitrateKbps,
            playlistPath: `${paths.prefix(payload.videoId)}${v.playlistPath}`,
            sizeBytes: v.sizeBytes,
          })),
        )
      }

      await tx
        .update(videos)
        .set({
          // 'ready', not 'published': transcoding finishing is not a decision to
          // make something public. Publishing is an operator action (plan §7).
          status: 'ready',
          durationSec: Math.round(result.probe.durationSec),
          hlsMasterPath: paths.master(payload.videoId),
          posterUrl: paths.poster(payload.videoId),
          spriteUrl: paths.sprite(payload.videoId),
          spriteVttUrl: paths.spriteVtt(payload.videoId),
          previewUrl: result.previewPath ? paths.preview(payload.videoId) : null,
          updatedAt: new Date(),
        })
        .where(eq(videos.id, payload.videoId))
    })

    onProgress(100, 'done')
  } finally {
    // Several GB per job. Leaving these behind fills the worker's disk within a
    // day and every subsequent job fails on write.
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Mark a video failed so it stops showing as stuck in `processing`. */
export async function markVideoFailed(videoId: string): Promise<void> {
  await db
    .update(videos)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(videos.id, videoId))
}
