import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, uploads, videos } from '@/db'
import { isAuthorisedUploader, unauthorised } from '@/lib/auth/upload-guard'
import { env } from '@/lib/env'
import { uniqueSlug } from '@/lib/slug'
import { getVideoProvider } from '@/lib/video'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z
    .string()
    .regex(/^video\/[a-z0-9.+-]+$/i, 'Only video/* uploads are accepted.'),
  sizeBytes: z.number().int().positive().max(env.MAX_UPLOAD_BYTES),
  title: z.string().min(1).max(200),
  language: z.string().min(2).max(10).default('hi'),
})


/**
 * Begin a resumable upload.
 *
 * Creates the video row and the upload record, then asks the provider for an
 * upload plan. Bytes go straight from the browser to the bucket — this endpoint
 * never sees them (plan §5.1).
 */
export async function POST(request: Request) {
  if (!isAuthorisedUploader(request)) return unauthorised()

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { filename, contentType, sizeBytes, title, language } = parsed.data
  const provider = await getVideoProvider()

  // The video row is created first so the provider has a stable id to key the
  // object path on.
  const [video] = await db
    .insert(videos)
    .values({
      slug: uniqueSlug(title),
      title,
      language,
      status: 'uploading',
      provider: provider.id,
    })
    .returning({ id: videos.id, slug: videos.slug })

  if (!video) return Response.json({ error: 'could_not_create_video' }, { status: 500 })

  let plan
  try {
    plan = await provider.createResumableUpload({
      videoId: video.id,
      filename,
      contentType,
      sizeBytes,
    })
  } catch (error) {
    // The video row is committed before this call, so a storage failure would
    // otherwise leave a row stuck in `uploading` forever — cluttering the admin
    // list and holding its slug.
    await db.delete(videos).where(eq(videos.id, video.id))

    console.error('createResumableUpload failed', error)
    return Response.json({ error: 'storage_unavailable' }, { status: 502 })
  }

  if (plan.protocol !== 'multipart') {
    // The TUS path hands the client an endpoint and gets out of the way; there
    // are no parts for the server to track.
    await db
      .update(videos)
      .set({ providerAssetId: plan.assetId })
      .where(eq(videos.id, video.id))

    return Response.json({ videoId: video.id, slug: video.slug, plan })
  }

  const [upload] = await db
    .insert(uploads)
    .values({
      videoId: video.id,
      objectKey: plan.objectKey,
      multipartId: plan.multipartId,
      partSizeBytes: plan.partSizeBytes,
      totalBytes: sizeBytes,
      totalParts: plan.totalParts,
      filename,
      contentType,
    })
    .returning({ id: uploads.id })

  return Response.json(
    { videoId: video.id, slug: video.slug, uploadId: upload!.id, plan },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
