/**
 * Continue Watching, against a real Postgres.
 *
 *   npm run check:history
 *
 * This suite exists because a 500 reached production on an endpoint the other
 * 69 tests never executed. The resume-band filter is raw SQL, and the bug was
 * a type error inside it — `coalesce(duration_sec, $n)` resolved the parameter
 * to integer from its sibling, so the fraction arrived as an integer literal
 * and Postgres refused it. Nothing that typechecks catches that; only running
 * the query does.
 *
 * The route handlers are invoked directly rather than over HTTP, so this needs
 * no server. It writes and deletes rows in `watch_history`, so point it at
 * development.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { and, eq } from 'drizzle-orm'

import type * as DbModule from '../src/db/index.ts'
import type * as HistoryModule from '../src/lib/queries/history.ts'
import { unmet } from './support.ts'

const skip = unmet(!process.env.DATABASE_URL ? 'DATABASE_URL is not set' : null)

describe('continue watching', { skip }, async () => {
  const { db, users, videos, watchHistory } = (await import('../src/db/index.ts')) as typeof DbModule
  const { listContinueWatching, recordPosition } = (await import(
    '../src/lib/queries/history.ts'
  )) as typeof HistoryModule

  const stamp = Date.now()
  let userId = ''
  const madeVideos: string[] = []

  let made = 0

  async function makeVideo(durationSec: number): Promise<string> {
    // Counter, not duration: several cases want the same runtime, and slugs are
    // unique, so keying on duration alone made the second insert fail.
    const [row] = await db
      .insert(videos)
      .values({
        slug: `check-history-${stamp}-${++made}`,
        title: `Check ${durationSec}s`,
        durationSec,
        status: 'published',
        publishedAt: new Date(Date.now() - 60_000),
        hlsMasterPath: 'v/none/master.m3u8',
      })
      .returning({ id: videos.id })

    madeVideos.push(row!.id)
    return row!.id
  }

  async function record(videoId: string, positionSec: number, clientDuration: number) {
    return recordPosition({ userId, videoId, positionSec, clientDurationSec: clientDuration })
  }

  const rail = () => listContinueWatching(userId)

  const [user] = await db
    .insert(users)
    .values({ email: `check-history-${stamp}@localhost.test`, displayName: 'check' })
    .returning({ id: users.id })
  userId = user!.id

  after(async () => {
    await db.delete(watchHistory).where(eq(watchHistory.userId, userId))
    for (const id of madeVideos) await db.delete(videos).where(eq(videos.id, id))
    await db.delete(users).where(eq(users.id, userId))
  })

  it('runs the band query without erroring', async () => {
    // The regression itself: this SQL answered 500 on every read in production.
    await assert.doesNotReject(() => listContinueWatching(userId))
  })

  it('shows a short video, whose band a flat 15s floor would leave empty', async () => {
    // 12s is the length of the seeded clips. Under an absolute floor every
    // qualifying position is at or past the end, so the title could never
    // appear at all.
    const videoId = await makeVideo(12)
    assert.equal(await record(videoId, 5, 12), 'recorded')

    const entry = (await rail()).find((i) => i.id === videoId)
    assert.ok(entry, 'a 12s video never reached Continue Watching')
    assert.equal(entry.positionSec, 5)
  })

  it('keeps the absolute floor for long content', async () => {
    // 5% of 30 minutes is 90s; the floor must win, or a 10s glance at an
    // episode fills the rail.
    const videoId = await makeVideo(1800)
    assert.equal(await record(videoId, 8, 1800), 'recorded')

    assert.ok(
      !(await rail()).some((i) => i.id === videoId),
      '8 seconds into a 30-minute episode is not something to resume',
    )
  })

  it('drops a title once it is effectively finished', async () => {
    const videoId = await makeVideo(600)
    await record(videoId, 300, 600)
    assert.ok((await rail()).some((i) => i.id === videoId), 'halfway should be resumable')

    await record(videoId, 595, 600)
    assert.ok(
      !(await rail()).some((i) => i.id === videoId),
      'a finished title must leave the rail',
    )
  })

  it('trusts the catalogue duration over the client', async () => {
    // The client claims a 2-hour runtime for a 10-minute video. Believing it
    // would leave a card pinned near 0% that never completes.
    const videoId = await makeVideo(600)
    await record(videoId, 590, 7200)

    assert.ok(
      !(await rail()).some((i) => i.id === videoId),
      'an inflated client duration kept a finished title on the rail',
    )
  })

  it('clamps a position past the end of the video', async () => {
    const videoId = await makeVideo(600)
    await record(videoId, 99_999, 99_999)

    const [row] = await db
      .select({ positionSec: watchHistory.positionSec, completed: watchHistory.completed })
      .from(watchHistory)
      .where(and(eq(watchHistory.userId, userId), eq(watchHistory.videoId, videoId)))

    assert.equal(row!.positionSec, 600, 'position must not exceed the runtime')
    assert.equal(row!.completed, true)
  })

  it('upserts rather than duplicating on repeated heartbeats', async () => {
    const videoId = await makeVideo(600)
    await record(videoId, 100, 600)
    await record(videoId, 200, 600)
    await record(videoId, 300, 600)

    const rows = await db
      .select({ positionSec: watchHistory.positionSec })
      .from(watchHistory)
      .where(and(eq(watchHistory.userId, userId), eq(watchHistory.videoId, videoId)))

    assert.equal(rows.length, 1, 'heartbeats inserted duplicate rows')
    assert.equal(rows[0]!.positionSec, 300)
  })

  it('reports an unknown video instead of writing a row', async () => {
    assert.equal(
      await recordPosition({
        userId,
        videoId: '00000000-0000-4000-8000-000000000000',
        positionSec: 30,
        clientDurationSec: 600,
      }),
      'unknown_video',
    )
  })
})
