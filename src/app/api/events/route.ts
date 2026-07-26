import { sql } from 'drizzle-orm'
import { z } from 'zod'

import { db, eventTypes, videoEvents } from '@/db'
import { clientIdentity, rateLimit, RULES, tooManyRequests } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * Playback telemetry ingest.
 *
 * Public and unauthenticated by necessity — anonymous viewers generate most of
 * the traffic — so everything here is written defensively:
 *
 *   - Batch size and field ranges are capped, so one request cannot insert an
 *     unbounded amount of work.
 *   - `videoId` is validated against real published videos before insert. The
 *     table deliberately has no foreign key (an FK check per row is too
 *     expensive on this path), so without this a script could fill the
 *     partition with rows referencing nothing.
 *   - Unknown event types are dropped rather than 400ing the batch. A newer
 *     client sending an event this deployment does not know about should lose
 *     that one event, not have its whole batch rejected.
 *
 * Rate limited per IP against a shared counter in Postgres — see
 * src/lib/rate-limit.ts for why that rather than the Redis in plan §4/§8, and
 * why the budget is loose. The caps above bound one request; the limiter bounds
 * how many requests, and invalid traffic is exactly what gets an ad account
 * banned (plan §9).
 */

const MAX_EVENTS_PER_REQUEST = 50

const eventSchema = z.object({
  videoId: z.uuid(),
  sessionId: z.uuid(),
  eventType: z.string().max(24),
  positionSec: z.number().int().min(0).max(86_400).optional(),
  // One batch covers ~15s of playback; anything larger is a client bug or a
  // forged payload, and inflated watch time corrupts creator revenue share.
  watchedSec: z.number().int().min(0).max(300).optional(),
  variant: z.string().max(12).optional(),
})

const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
})

const knownEventTypes = new Set<string>(eventTypes)

export async function POST(request: Request) {
  // Before reading the body: a flood should cost this endpoint one upsert, not
  // a parse of whatever the caller decided to send.
  const limit = await rateLimit(RULES.events, clientIdentity(request))
  if (!limit.ok) return tooManyRequests(limit)

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request' }, { status: 400 })
  }

  const events = parsed.data.events.filter((e) => knownEventTypes.has(e.eventType))
  if (events.length === 0) return new Response(null, { status: 204 })

  // One query to confirm every referenced video exists and is public. Cheaper
  // than a foreign key per row, and it also stops events being recorded against
  // unpublished or removed titles.
  const ids = [...new Set(events.map((e) => e.videoId))]
  const live = await db.execute<{ id: string }>(sql`
    SELECT id FROM videos
     WHERE id = ANY(${sql.param(ids)}::uuid[])
       AND status = 'published'
       AND deleted_at IS NULL
  `)

  const allowed = new Set(live.map((r) => r.id))
  const rows = events.filter((e) => allowed.has(e.videoId))
  if (rows.length === 0) return new Response(null, { status: 204 })

  await db.insert(videoEvents).values(
    rows.map((e) => ({
      videoId: e.videoId,
      sessionId: e.sessionId,
      eventType: e.eventType,
      positionSec: e.positionSec ?? null,
      watchedSec: e.watchedSec ?? null,
      variant: e.variant ?? null,
    })),
  )

  // 204 rather than a body: the client never reads the response, and beacons
  // discard it regardless.
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
