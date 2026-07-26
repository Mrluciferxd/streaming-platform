/**
 * Verifies the telemetry path: ingest → video_events → rollup →
 * video_stats_daily → videos.view_count.
 *
 *   npm run check:analytics   (against a running dev server)
 *
 * This path was dead for three phases — the rollup functions and the
 * partitioned table existed, but nothing ever wrote an event, so the trending
 * rail silently fell back to "newest" and every view count was whatever the
 * seed had put there. A broken analytics pipeline does not throw; it just
 * quietly reports zeros, which is why it needs a test.
 */
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { videos } from '../src/db/schema.ts'
import { videoStatsDaily } from '../src/db/schema-analytics.ts'

const base = process.argv[2] ?? 'http://localhost:3000'
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const client = postgres(url, { max: 1 })
const db = drizzle(client)

let failures = 0
function check(ok: boolean, label: string, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const [video] = await db
  .select({ id: videos.id, slug: videos.slug })
  .from(videos)
  .where(eq(videos.status, 'published'))
  .limit(1)

if (!video) {
  console.error('No published video to test against. Run: npm run seed:video')
  await client.end()
  process.exit(1)
}

const sessionId = crypto.randomUUID()
const today = new Date().toISOString().slice(0, 10)

// --- Ingest -----------------------------------------------------------------
const send = (events: unknown[]) =>
  fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  })

const ok = await send([
  { videoId: video.id, sessionId, eventType: 'play', positionSec: 0 },
  { videoId: video.id, sessionId, eventType: 'progress', positionSec: 15, watchedSec: 15 },
  { videoId: video.id, sessionId, eventType: 'progress', positionSec: 30, watchedSec: 15 },
  { videoId: video.id, sessionId, eventType: 'rebuffer', positionSec: 31 },
  { videoId: video.id, sessionId, eventType: 'complete', positionSec: 40, watchedSec: 10 },
])
check(ok.status === 204, 'valid batch accepted', `http ${ok.status}`)

// --- Validation -------------------------------------------------------------
const bad = await send([{ videoId: 'not-a-uuid', sessionId, eventType: 'play' }])
check(bad.status === 400, 'malformed batch rejected', `http ${bad.status}`)

const ghost = await send([
  { videoId: '00000000-0000-4000-8000-000000000000', sessionId, eventType: 'play' },
])
check(ghost.status === 204, 'events for unknown videos are dropped, not stored', `http ${ghost.status}`)

const unknown = await send([{ videoId: video.id, sessionId, eventType: 'teleport' }])
check(unknown.status === 204, 'unknown event type dropped without failing the batch', `http ${unknown.status}`)

const huge = await send(
  Array.from({ length: 80 }, () => ({ videoId: video.id, sessionId, eventType: 'progress' })),
)
check(huge.status === 400, 'oversized batch rejected', `http ${huge.status}`)

const inflated = await send([
  { videoId: video.id, sessionId, eventType: 'progress', watchedSec: 99999 },
])
check(inflated.status === 400, 'implausible watch time rejected', `http ${inflated.status}`)

// --- Stored -----------------------------------------------------------------
const [stored] = await db.execute<{ c: number; watched: number }>(sql`
  SELECT count(*)::int AS c, coalesce(sum(watched_sec), 0)::int AS watched
    FROM video_events WHERE session_id = ${sessionId}::uuid
`)
check(stored?.c === 5, 'exactly the five valid events landed', `${stored?.c} rows`)
check(stored?.watched === 40, 'watch seconds summed correctly', `${stored?.watched}s`)

// --- Rollup -----------------------------------------------------------------
await db.execute(sql`SELECT rollup_video_stats(${today}::date)`)

const [stats] = await db
  .select()
  .from(videoStatsDaily)
  .where(and(eq(videoStatsDaily.videoId, video.id), eq(videoStatsDaily.day, today)))

check(Boolean(stats), 'rollup produced a daily row')
check((stats?.views ?? 0) >= 1, 'play counted as a view', `views=${stats?.views}`)
check((stats?.watchSeconds ?? 0) >= 40, 'watch seconds rolled up', `${stats?.watchSeconds}s`)
check((stats?.completions ?? 0) >= 1, 'completion counted', `${stats?.completions}`)
check((stats?.rebufferEvents ?? 0) >= 1, 'rebuffer counted — this is the QoE signal plan §8 targets')

// Re-running must not double-count; the job is retried on failure.
const before = stats?.views ?? 0
await db.execute(sql`SELECT rollup_video_stats(${today}::date)`)
const [again] = await db
  .select()
  .from(videoStatsDaily)
  .where(and(eq(videoStatsDaily.videoId, video.id), eq(videoStatsDaily.day, today)))
check(again?.views === before, 'rollup is idempotent', `${before} → ${again?.views}`)

// --- view_count sync --------------------------------------------------------
const [refreshed] = await db
  .select({ viewCount: videos.viewCount })
  .from(videos)
  .where(eq(videos.id, video.id))
check(
  (refreshed?.viewCount ?? 0) >= 1,
  'videos.view_count synced from the rollup, not written on the play path',
  `${refreshed?.viewCount}`,
)

// --- Cleanup ----------------------------------------------------------------
await db.execute(sql`DELETE FROM video_events WHERE session_id = ${sessionId}::uuid`)
await db.execute(sql`SELECT rollup_video_stats(${today}::date)`)

await client.end()
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
