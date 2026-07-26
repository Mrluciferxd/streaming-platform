import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, uploads, videos } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { enqueue } from '@/lib/jobs/queue'
import { getVideoProvider } from '@/lib/video'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * Finalise the upload and queue transcoding.
 *
 * Parts are read back from the provider rather than trusted from the request
 * body: the client's idea of what it uploaded can be stale or wrong, and R2
 * already knows exactly which parts and ETags it holds.
 */
export async function POST(_request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const [upload] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1)
  if (!upload) return Response.json({ error: 'not_found' }, { status: 404 })

  // Completing twice should be harmless — a client that retries after a timeout
  // must not get an error for work that already succeeded.
  if (upload.status === 'completed') {
    return Response.json({ ok: true, videoId: upload.videoId, alreadyCompleted: true })
  }
  if (upload.status !== 'pending') {
    return Response.json({ error: 'upload_not_pending', status: upload.status }, { status: 409 })
  }
  if (!upload.multipartId) {
    return Response.json({ error: 'not_a_multipart_upload' }, { status: 409 })
  }

  const provider = await getVideoProvider()
  const parts = await provider.listUploadedParts({
    objectKey: upload.objectKey,
    multipartId: upload.multipartId,
  })

  if (parts.length !== upload.totalParts) {
    const present = new Set(parts.map((p) => p.partNumber))
    const missing: number[] = []
    for (let n = 1; n <= upload.totalParts; n++) if (!present.has(n)) missing.push(n)

    return Response.json(
      { error: 'incomplete_upload', expected: upload.totalParts, received: parts.length, missing },
      { status: 409 },
    )
  }

  await provider.completeResumableUpload({
    objectKey: upload.objectKey,
    multipartId: upload.multipartId,
    parts,
  })

  /**
   * Marking the upload done, moving the video to `processing`, and enqueueing
   * the job all commit together. This is the reason the queue lives in Postgres
   * (see the `jobs` table comment): with Redis there is a window where the
   * video says `processing` but no job exists, or a job runs against a video
   * that was never marked complete.
   */
  const jobId = await db.transaction(async (tx) => {
    await tx
      .update(uploads)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(uploads.id, upload.id))

    await tx
      .update(videos)
      .set({
        status: 'processing',
        sourceSizeBytes: upload.totalBytes,
        providerAssetId: upload.objectKey,
        updatedAt: new Date(),
      })
      .where(eq(videos.id, upload.videoId))

    return enqueue(
      'transcode',
      { videoId: upload.videoId, objectKey: upload.objectKey },
      // Keyed on the video, so a double-submit cannot start two transcodes of
      // the same source writing to the same output prefix.
      { dedupeKey: `transcode:${upload.videoId}`, maxAttempts: 3 },
      tx,
    )
  })

  return Response.json(
    { ok: true, videoId: upload.videoId, jobId },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
