import { timingSafeEqual } from 'node:crypto'

import { sql } from 'drizzle-orm'

import { db, videos } from '@/db'
import { isOperator } from '@/lib/auth/require-role'
import { clientIp, getSessionUser } from '@/lib/auth/session'
import { env } from '@/lib/env'
import { recordAudit } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

/**
 * Flip scheduled titles live.
 *
 * A schedule is stored as `status = 'ready'` with a future `published_at` (see
 * ../videos/[id]/status), so something has to make it real. This is that
 * something: idempotent, safe to run as often as you like, and it only ever
 * touches rows that are `ready`, not live and not deleted — so it can never
 * resurrect an unpublished or taken-down title.
 *
 * Wire it to cron alongside the nightly rollup. Until it is scheduled, an
 * operator can run it from the library page, and the UI says so rather than
 * pretending a schedule set itself.
 *
 * Two callers, two credentials: an operator session for the manual run, and the
 * cron bearer for the automated one — a cron job has no session to present.
 */
export async function POST(request: Request) {
  return sweep(request)
}

/** Vercel Cron issues GET. */
export async function GET(request: Request) {
  return sweep(request)
}

async function sweep(request: Request) {
  const user = await getSessionUser()
  const bySession = isOperator(user)

  if (!bySession && !hasCronSecret(request)) {
    return Response.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const due = await db.execute<{ id: string; title: string; published_at: string }>(sql`
    UPDATE videos
       SET status     = 'published',
           updated_at = now()
     WHERE status       = 'ready'
       AND deleted_at   IS NULL
       AND published_at IS NOT NULL
       AND published_at <= now()
       AND hls_master_path IS NOT NULL
    RETURNING id, title, published_at
  `)

  for (const row of due) {
    await recordAudit({
      // Null actor when cron did it. The trail should say "the schedule fired",
      // not name whoever happened to be signed in.
      actorId: bySession && user ? user.id : null,
      action: 'video.publish',
      entityType: 'video',
      entityId: row.id,
      before: { status: 'ready' },
      after: { status: 'published', title: row.title, viaSchedule: true },
      ip: bySession ? clientIp(request) : null,
    })
  }

  return Response.json(
    { ok: true, published: due.length, ids: due.map((r) => r.id) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

function hasCronSecret(request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!provided) return false

  const a = Buffer.from(provided)
  const b = Buffer.from(env.CRON_SECRET)
  // Comparing lengths first would itself leak; run a dummy compare instead.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }

  return timingSafeEqual(a, b)
}
