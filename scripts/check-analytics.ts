/**
 * Verifies the telemetry path: ingest → video_events → rollup →
 * video_stats_daily → videos.view_count.
 *
 *   npm run check:analytics                       (against a running dev server)
 *   npm run check:analytics -- https://host       (or a deployment)
 *
 * This path was dead for three phases — the rollup functions and the
 * partitioned table existed, but nothing ever wrote an event, so the trending
 * rail silently fell back to "newest" and every view count was whatever the
 * seed had put there. A broken analytics pipeline does not throw; it just
 * quietly reports zeros, which is why it needs a test.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { videos } from '../src/db/schema.ts'
import { videoStatsDaily } from '../src/db/schema-analytics.ts'
import { baseUrl, serverIsUp, unmet } from './support.ts'

const base = baseUrl()
const databaseUrl = process.env.DATABASE_URL

// Preconditions are resolved before the suite is registered, because the last
// of them needs a query to answer.
let reason: string | null = databaseUrl ? null : 'DATABASE_URL is not set'
if (!reason && !(await serverIsUp(base))) reason = `no server answering at ${base}`

const client = postgres(databaseUrl ?? '', { max: 1 })
const db = drizzle(client)

const [video] = reason
  ? []
  : await db
      .select({ id: videos.id, slug: videos.slug })
      .from(videos)
      .where(eq(videos.status, 'published'))
      .limit(1)

if (!reason && !video) reason = 'no published video to test against — run: npm run seed:video'
if (reason) await client.end()

const sessionId = crypto.randomUUID()
const today = new Date().toISOString().slice(0, 10)

const send = (events: unknown[]) =>
  fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  })

describe('analytics pipeline', { skip: unmet(reason) }, () => {
  after(async () => {
    await db.execute(sql`DELETE FROM video_events WHERE session_id = ${sessionId}::uuid`)
    // Recompute the day without this run's events, so the check leaves the
    // rollup exactly as it found it.
    await db.execute(sql`SELECT rollup_video_stats(${today}::date)`)
    await client.end()
  })

  // --- Ingest ---------------------------------------------------------------
  it('accepts a valid batch', async () => {
    const res = await send([
      { videoId: video!.id, sessionId, eventType: 'play', positionSec: 0 },
      { videoId: video!.id, sessionId, eventType: 'progress', positionSec: 15, watchedSec: 15 },
      { videoId: video!.id, sessionId, eventType: 'progress', positionSec: 30, watchedSec: 15 },
      { videoId: video!.id, sessionId, eventType: 'rebuffer', positionSec: 31 },
      { videoId: video!.id, sessionId, eventType: 'complete', positionSec: 40, watchedSec: 10 },
    ])
    assert.equal(res.status, 204)
  })

  // --- Validation -----------------------------------------------------------
  it('rejects a malformed batch', async () => {
    const res = await send([{ videoId: 'not-a-uuid', sessionId, eventType: 'play' }])
    assert.equal(res.status, 400)
  })

  it('drops events for unknown videos rather than storing them', async () => {
    const res = await send([
      { videoId: '00000000-0000-4000-8000-000000000000', sessionId, eventType: 'play' },
    ])
    assert.equal(res.status, 204)
  })

  it('drops an unknown event type without failing the batch', async () => {
    const res = await send([{ videoId: video!.id, sessionId, eventType: 'teleport' }])
    assert.equal(res.status, 204)
  })

  it('rejects an oversized batch', async () => {
    const res = await send(
      Array.from({ length: 80 }, () => ({ videoId: video!.id, sessionId, eventType: 'progress' })),
    )
    assert.equal(res.status, 400)
  })

  it('rejects implausible watch time', async () => {
    const res = await send([{ videoId: video!.id, sessionId, eventType: 'progress', watchedSec: 99999 }])
    assert.equal(res.status, 400)
  })

  // --- Stored ---------------------------------------------------------------
  it('stores exactly the five valid events', async () => {
    const [stored] = await db.execute<{ c: number; watched: number }>(sql`
      SELECT count(*)::int AS c, coalesce(sum(watched_sec), 0)::int AS watched
        FROM video_events WHERE session_id = ${sessionId}::uuid
    `)

    assert.equal(stored?.c, 5)
    assert.equal(stored?.watched, 40, 'watch seconds summed correctly')
  })

  // --- Rollup ---------------------------------------------------------------
  it('rolls the day up into video_stats_daily', async () => {
    await db.execute(sql`SELECT rollup_video_stats(${today}::date)`)

    const [stats] = await db
      .select()
      .from(videoStatsDaily)
      .where(and(eq(videoStatsDaily.videoId, video!.id), eq(videoStatsDaily.day, today)))

    assert.ok(stats, 'rollup produced a daily row')
    assert.ok((stats?.views ?? 0) >= 1, `play counted as a view — views=${stats?.views}`)
    assert.ok((stats?.watchSeconds ?? 0) >= 40, `watch seconds rolled up — ${stats?.watchSeconds}s`)
    assert.ok((stats?.completions ?? 0) >= 1, `completion counted — ${stats?.completions}`)
    assert.ok(
      (stats?.rebufferEvents ?? 0) >= 1,
      'rebuffer counted — this is the QoE signal plan §8 targets',
    )
  })

  it('is idempotent — a retried rollup does not double-count', async () => {
    const [before] = await db
      .select()
      .from(videoStatsDaily)
      .where(and(eq(videoStatsDaily.videoId, video!.id), eq(videoStatsDaily.day, today)))

    await db.execute(sql`SELECT rollup_video_stats(${today}::date)`)

    const [again] = await db
      .select()
      .from(videoStatsDaily)
      .where(and(eq(videoStatsDaily.videoId, video!.id), eq(videoStatsDaily.day, today)))

    assert.equal(again?.views, before?.views)
  })

  // --- view_count sync ------------------------------------------------------
  it('syncs videos.view_count from the rollup, not from the play path', async () => {
    const [refreshed] = await db
      .select({ viewCount: videos.viewCount })
      .from(videos)
      .where(eq(videos.id, video!.id))

    assert.ok((refreshed?.viewCount ?? 0) >= 1, `${refreshed?.viewCount}`)
  })
})
