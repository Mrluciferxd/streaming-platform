import { timingSafeEqual } from 'node:crypto'

import { env } from '@/lib/env'

/**
 * Shared gate for /api/cron/*.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without this check
 * every cron endpoint is a public trigger for a minute of database work, which
 * is a denial-of-service primitive with a nice URL.
 *
 * Constant-time comparison rather than `===`: a byte-by-byte early return is
 * measurable over enough requests, and this is a fixed secret that never
 * rotates on its own.
 */
export function isAuthorisedCron(request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!provided) return false

  const a = Buffer.from(provided)
  const b = Buffer.from(env.CRON_SECRET)

  // timingSafeEqual throws on a length mismatch, and returning early on length
  // would itself leak it. Burn an equivalent comparison and refuse.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }

  return timingSafeEqual(a, b)
}

export function unauthorisedCron(): Response {
  return Response.json(
    { error: 'unauthorised' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  )
}
