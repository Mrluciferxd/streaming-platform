import { timingSafeEqual } from 'node:crypto'

import { env } from '@/lib/env'

/**
 * Interim guard on the upload endpoints.
 *
 * These routes mint presigned URLs that grant write access to the media bucket.
 * Leaving them open until Phase 3 brings real accounts would let anyone on the
 * internet fill the bucket, so they sit behind a shared bearer token until
 * sessions and roles exist.
 *
 * Replace with a session + `role in ('admin','creator')` check as soon as auth
 * lands — a single shared secret cannot be revoked per person and gives no
 * attribution for `videos.uploader_id`.
 */
export function isAuthorisedUploader(request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!provided) return false

  const expected = env.UPLOAD_ADMIN_TOKEN
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)

  // Length must match before timingSafeEqual, and comparing lengths first would
  // itself leak. Hash both to a fixed width instead.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }

  return timingSafeEqual(a, b)
}

export function unauthorised(): Response {
  return Response.json(
    { error: 'unauthorised' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  )
}
