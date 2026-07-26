import { spawn } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildEncodeArgs,
  buildMasterPlaylist,
  variantDirNames,
  type PlannedRendition,
} from './encode'
import { FFMPEG, probe as probeFile, type ProbeResult } from './probe'
import {
  buildPosterArgs,
  buildPreviewArgs,
  buildSpriteArgs,
  buildSpriteVtt,
  planSprite,
} from './sprite'
import { AUDIO } from './types'

/**
 * The local half of the transcode pipeline: source file in, a complete HLS
 * package on disk out. Uploading the result and updating the database is the
 * worker's job — keeping those separate means this can be run and inspected
 * without any cloud credentials (scripts/transcode-local.ts).
 */

export class TranscodeError extends Error {}

export type VariantOutput = {
  name: string
  width: number
  height: number
  bitrateKbps: number
  peakBitrateKbps: number
  codec: string
  playlistPath: string
  sizeBytes: number
}

export type TranscodeResult = {
  probe: ProbeResult
  renditions: PlannedRendition[]
  variants: VariantOutput[]
  hasAudio: boolean
  masterPath: string
  posterPath: string
  spritePath: string
  spriteVttPath: string
  previewPath: string | null
  totalBytes: number
}

export type ProgressFn = (percent: number, stage: string) => void

/**
 * Run FFmpeg, streaming `-progress` output back to the caller.
 *
 * A transcode can run for many minutes, and the worker has to heartbeat while
 * it does or the reaper will assume it died. That makes progress reporting a
 * liveness requirement, not a nicety.
 */
function runFfmpeg(
  args: string[],
  opts: { durationSec?: number; onProgress?: ProgressFn; stage: string } = { stage: 'encode' },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    let buffer = ''

    child.stdout.on('data', (chunk: Buffer) => {
      if (!opts.onProgress || !opts.durationSec) return

      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const [key, value] = line.split('=')
        if (key !== 'out_time_us' || !value) continue

        const seconds = Number(value) / 1_000_000
        if (!Number.isFinite(seconds)) continue

        opts.onProgress(Math.min(100, (seconds / opts.durationSec) * 100), opts.stage)
      }
    })

    // FFmpeg writes everything human-readable to stderr, including real errors.
    // Keeping only the tail avoids holding megabytes for a job that succeeds.
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000)
    })

    child.on('error', (error) => {
      reject(new TranscodeError(`Could not start ${FFMPEG}: ${error.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new TranscodeError(`ffmpeg exited ${code}\n${stderr.trim()}`))
    })
  })
}

async function directorySize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true })
  let total = 0

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size
  }

  return total
}

/**
 * Transcode `input` into a complete HLS package under `outDir`.
 *
 * Layout:
 *   master.m3u8
 *   240p/playlist.m3u8  init.mp4  seg_00000.m4s …
 *   audio/playlist.m3u8 init.mp4  seg_00000.m4s …
 *   poster.jpg  sprite.jpg  sprite.vtt  preview.webp
 */
export async function transcodeToHls(
  input: string,
  outDir: string,
  onProgress?: ProgressFn,
): Promise<TranscodeResult> {
  const probe = await probeFile(input)

  const plan = buildEncodeArgs(input, outDir, probe)
  if (plan.renditions.length === 0) {
    throw new TranscodeError('No renditions selected; source resolution is unusable.')
  }

  // FFmpeg's hls muxer will not create the %v directories itself.
  await mkdir(outDir, { recursive: true })
  for (const name of variantDirNames(plan.renditions, probe.hasAudio)) {
    await mkdir(path.join(outDir, name), { recursive: true })
  }

  // The ladder is the long pole — hold it to 85% of the reported progress so
  // the remaining stages still have somewhere to move.
  await runFfmpeg(plan.args, {
    durationSec: probe.durationSec,
    stage: 'encode',
    onProgress: onProgress && ((p) => onProgress(p * 0.85, 'encode')),
  })

  onProgress?.(86, 'poster')
  const posterPath = path.join(outDir, 'poster.jpg')
  await runFfmpeg(buildPosterArgs(input, posterPath, probe), { stage: 'poster' })

  onProgress?.(90, 'sprite')
  const spritePlan = planSprite(probe)
  const spritePath = path.join(outDir, 'sprite.jpg')
  await runFfmpeg(buildSpriteArgs(input, spritePath, spritePlan), { stage: 'sprite' })

  const spriteVttPath = path.join(outDir, 'sprite.vtt')
  await writeFile(spriteVttPath, buildSpriteVtt(spritePlan, probe), 'utf8')

  // The hover preview is cosmetic, and libwebp is not in every FFmpeg build.
  // Losing it should never fail a video that is otherwise ready to publish.
  onProgress?.(94, 'preview')
  let previewPath: string | null = path.join(outDir, 'preview.webp')
  try {
    await runFfmpeg(buildPreviewArgs(input, previewPath, probe), { stage: 'preview' })
  } catch {
    previewPath = null
  }

  onProgress?.(97, 'manifest')
  const masterPath = path.join(outDir, 'master.m3u8')
  await writeFile(masterPath, buildMasterPlaylist(plan.renditions, { hasAudio: probe.hasAudio }), 'utf8')

  const variants: VariantOutput[] = []
  for (const r of plan.renditions) {
    variants.push({
      name: r.name,
      width: r.actualWidth,
      height: r.actualHeight,
      bitrateKbps: r.bitrateKbps,
      peakBitrateKbps: r.peakBitrateKbps,
      codec: r.profile === 'high' ? 'high' : 'main',
      playlistPath: `${r.name}/playlist.m3u8`,
      sizeBytes: await directorySize(path.join(outDir, r.name)),
    })
  }

  if (probe.hasAudio) {
    variants.push({
      name: AUDIO.name,
      width: 0,
      height: 0,
      bitrateKbps: AUDIO.bitrateKbps,
      peakBitrateKbps: AUDIO.bitrateKbps,
      codec: AUDIO.codec,
      playlistPath: `${AUDIO.name}/playlist.m3u8`,
      sizeBytes: await directorySize(path.join(outDir, AUDIO.name)),
    })
  }

  onProgress?.(100, 'done')

  return {
    probe,
    renditions: plan.renditions,
    variants,
    hasAudio: probe.hasAudio,
    masterPath,
    posterPath,
    spritePath,
    spriteVttPath,
    previewPath,
    totalBytes: await directorySize(outDir),
  }
}
