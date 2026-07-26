import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, uploads } from '@/db'
import { isAuthorisedUploader, unauthorised } from '@/lib/auth/upload-guard'
import { getVideoProvider } from '@/lib/video'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

async function loadUpload(id: string) {
  if (!z.uuid().safeParse(id).success) return null

  const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1)
  return row ?? null
}

/**
 * Upload status, including which parts already landed.
 *
 * This is what makes a resume possible: a client whose connection dropped asks
 * here, learns parts 1–37 are stored, and uploads only 38 onward. R2 is the
 * source of truth rather than anything the client remembers, so a resume works
 * even from a different device or after a browser crash.
 */
export async function GET(request: Request, { params }: Params) {
  if (!isAuthorisedUploader(request)) return unauthorised()

  const upload = await loadUpload((await params).id)
  if (!upload) return Response.json({ error: 'not_found' }, { status: 404 })

  if (!upload.multipartId) {
    return Response.json({ error: 'not_a_multipart_upload' }, { status: 409 })
  }

  const provider = await getVideoProvider()
  const parts = await provider.listUploadedParts({
    objectKey: upload.objectKey,
    multipartId: upload.multipartId,
  })

  const uploadedNumbers = new Set(parts.map((p) => p.partNumber))
  const missing: number[] = []
  for (let n = 1; n <= upload.totalParts; n++) {
    if (!uploadedNumbers.has(n)) missing.push(n)
  }

  return Response.json(
    {
      uploadId: upload.id,
      videoId: upload.videoId,
      status: upload.status,
      partSizeBytes: upload.partSizeBytes,
      totalParts: upload.totalParts,
      uploaded: parts,
      missing,
      bytesStored: parts.reduce((sum, p) => sum + p.sizeBytes, 0),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

const signSchema = z.object({
  // Signed in batches so a 2 GB upload needs a handful of round trips rather
  // than one per part.
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
})

/** Presign a batch of part URLs. */
export async function POST(request: Request, { params }: Params) {
  if (!isAuthorisedUploader(request)) return unauthorised()

  const upload = await loadUpload((await params).id)
  if (!upload) return Response.json({ error: 'not_found' }, { status: 404 })
  if (upload.status !== 'pending') {
    return Response.json({ error: 'upload_not_pending', status: upload.status }, { status: 409 })
  }
  if (!upload.multipartId) {
    return Response.json({ error: 'not_a_multipart_upload' }, { status: 409 })
  }

  const parsed = signSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const outOfRange = parsed.data.partNumbers.filter((n) => n > upload.totalParts)
  if (outOfRange.length > 0) {
    return Response.json({ error: 'part_number_out_of_range', outOfRange }, { status: 400 })
  }

  const provider = await getVideoProvider()
  const urls = await Promise.all(
    parsed.data.partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await provider.signUploadPart({
        objectKey: upload.objectKey,
        multipartId: upload.multipartId!,
        partNumber,
      }),
    })),
  )

  return Response.json({ urls }, { headers: { 'Cache-Control': 'no-store' } })
}

/** Abandon the upload and release the stored parts. */
export async function DELETE(request: Request, { params }: Params) {
  if (!isAuthorisedUploader(request)) return unauthorised()

  const upload = await loadUpload((await params).id)
  if (!upload) return Response.json({ error: 'not_found' }, { status: 404 })

  if (upload.status === 'pending' && upload.multipartId) {
    const provider = await getVideoProvider()
    // Until this runs, the uploaded parts keep billing as R2 storage while
    // being invisible in the bucket listing.
    await provider.abortResumableUpload({
      objectKey: upload.objectKey,
      multipartId: upload.multipartId,
    })
  }

  await db.update(uploads).set({ status: 'aborted' }).where(eq(uploads.id, upload.id))

  return Response.json({ ok: true })
}
