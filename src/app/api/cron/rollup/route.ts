import { timingSafeEqual } from 'node:crypto'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
// Rollup over a day of events plus partition maintenance; the default 10s
// serverless budget is not enough once the events table has real volume.
export const maxDuration = 60

/**
 * Nightly maintenance.
 *
 * Three jobs, deliberately in one endpoint because they must run in this order:
 *
 *   1. Roll yesterday's raw events into `video_stats_daily`, and sync
 *      `videos.view_count` from it. Until this runs the trending rail silently
 *      degrades to "newest" and every view count is stale.
 *   2. Create next month's `video_events` partition, several weeks ahead. If
 *      this is ever missed, inserts fall into the default partition — degraded,
 *      not broken, which is why the default partition exists.
 *   3. Drop partitions past the 35-day retention window.
 *
 * Rolling up *yesterday* rather than today: today is still accumulating, and a
 * partial day written into the rollup would be overwritten on the next run
 * anyway. `rollup_video_stats` recomputes rather than accumulates, so a retry
 * or a double-fire cannot double-count.
 */
export async function GET(request: Request) {
  if (!isAuthorised(request)) {
    return Response.json({ error: 'unauthorised' }, { status: 401 })
  }

  const started = Date.now()
  const result: Record<string, unknown> = {}

  try {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

    const [rolled] = await db.execute<{ rollup_video_stats: number }>(
      sql`SELECT rollup_video_stats(${yesterday}::date)`,
    )
    result.day = yesterday
    result.videosRolledUp = rolled?.rollup_video_stats ?? 0

    // Two months ahead, so a single missed run is not an incident.
    await db.execute(
      sql`SELECT ensure_video_events_partition((date_trunc('month', now()) + interval '2 months')::date)`,
    )
    result.partitionEnsured = true

    const [pruned] = await db.execute<{ prune_video_events: number }>(
      sql`SELECT prune_video_events(35)`,
    )
    result.partitionsDropped = pruned?.prune_video_events ?? 0

    return Response.json(
      { ok: true, ...result, ms: Date.now() - started },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    console.error('rollup cron failed', error)
    return Response.json(
      { ok: false, ...result, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without this check the
 * endpoint is a public trigger for a minute of database work.
 */
function isAuthorised(request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!provided) return false

  const a = Buffer.from(provided)
  const b = Buffer.from(env.CRON_SECRET)
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }

  return timingSafeEqual(a, b)
}
