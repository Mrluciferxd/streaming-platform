/**
 * Exercises the job queue's coordination guarantees against a real Postgres.
 *
 *   npm run check:queue
 *
 * These are the properties that look fine in casual use and fail under load:
 * two workers claiming the same job, a dedupe key that does not dedupe, a
 * reaper that requeues jobs which are still running. All of them produce
 * duplicate transcodes writing to the same output prefix.
 *
 * Writes and deletes rows in `jobs`, so point it at a development database.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { eq, inArray, sql } from 'drizzle-orm'

import type * as DbModule from '../src/db/index.ts'
import type * as QueueModule from '../src/lib/jobs/queue.ts'
import { unmet } from './support.ts'

const skip = unmet(process.env.DATABASE_URL ? null : 'DATABASE_URL is not set')

/**
 * Imported only when the suite will actually run. `src/db` validates the entire
 * environment at module load, so importing it with no database configured would
 * throw before the runner ever got to report a skip.
 */
const { db, jobs, sqlClient } = skip ? ({} as typeof DbModule) : await import('../src/db/index.ts')
const { claim, complete, enqueue, fail, heartbeat, kill, reap } = skip
  ? ({} as typeof QueueModule)
  : await import('../src/lib/jobs/queue.ts')

const tag = `check-${Date.now()}`
const videoId = '00000000-0000-4000-8000-000000000001'
const created: number[] = []

function track(id: number | null): number {
  assert.ok(id !== null, 'expected an enqueued job id')
  created.push(id)
  return id
}

describe('job queue', { skip }, () => {
  after(async () => {
    if (created.length > 0) await db.delete(jobs).where(inArray(jobs.id, created))
    // Anything this run left behind, in case of an early throw.
    await db.delete(jobs).where(sql`${jobs.dedupeKey} like ${`${tag}:%`}`)
    await sqlClient.end()
  })

  // --- Enqueue and claim ----------------------------------------------------
  it('a queued job can be claimed, once', async () => {
    const a = track(await enqueue('transcode', { videoId, objectKey: 'a' }, { dedupeKey: `${tag}:a` }))

    const claimed = await claim('worker-1', ['transcode'])
    assert.equal(claimed?.id, a)
    assert.equal(claimed?.attempts, 1, 'claiming increments the attempt counter')

    const second = await claim('worker-2', ['transcode'])
    assert.equal(second, null, 'a running job is never handed to a second worker')

    await complete(a)
  })

  // --- Concurrent claims ----------------------------------------------------
  // The real test of SKIP LOCKED: many workers racing for a small pool of jobs
  // must partition them, never duplicate them.
  it('20 concurrent claimers get exactly the 8 available jobs, each once', async () => {
    const poolSize = 8
    for (let i = 0; i < poolSize; i++) {
      track(await enqueue('transcode', { videoId, objectKey: `p${i}` }, { dedupeKey: `${tag}:p${i}` }))
    }

    const racers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claim(`racer-${i}`, ['transcode'])),
    )
    const won = racers.filter((j): j is NonNullable<typeof j> => j !== null)
    const uniqueIds = new Set(won.map((j) => j.id))

    assert.equal(won.length, poolSize)
    assert.equal(uniqueIds.size, won.length, 'no job is claimed twice')

    for (const j of won) await complete(j.id)
  })

  // --- Dedupe ---------------------------------------------------------------
  it('a dedupe key holds while a job is live and releases once it finishes', async () => {
    track(await enqueue('transcode', { videoId, objectKey: 'd' }, { dedupeKey: `${tag}:d` }))

    const queued = await enqueue('transcode', { videoId, objectKey: 'd' }, { dedupeKey: `${tag}:d` })
    assert.equal(queued, null, 'a live job with the same dedupe key is not re-enqueued')

    const dClaimed = await claim('worker-1', ['transcode'])
    const running = await enqueue('transcode', { videoId, objectKey: 'd' }, { dedupeKey: `${tag}:d` })
    assert.equal(running, null, 'dedupe still holds while the job is running')

    await complete(dClaimed!.id)
    const afterDone = await enqueue('transcode', { videoId, objectKey: 'd' }, { dedupeKey: `${tag}:d` })
    assert.notEqual(afterDone, null, 'the same key can be enqueued again once the job finished')

    track(afterDone)
    await complete((await claim('worker-1', ['transcode']))!.id)
  })

  // --- Retry and backoff ----------------------------------------------------
  it('failures retry with backoff, then park the job as dead', async () => {
    const r = track(
      await enqueue('transcode', { videoId, objectKey: 'r' }, { dedupeKey: `${tag}:r`, maxAttempts: 2 }),
    )

    const first = await claim('worker-1', ['transcode'])
    assert.equal(
      await fail(first!.id, new Error('transient R2 error')),
      'retry',
      'a failure below max_attempts retries',
    )

    const [afterFail] = await db.select().from(jobs).where(eq(jobs.id, r))
    assert.equal(afterFail!.status, 'queued', 'a retrying job returns to queued')
    assert.ok(
      afterFail!.runAt.getTime() > Date.now() + 20_000,
      `retry is delayed by backoff, not immediate — runAt is ${Math.round(
        (afterFail!.runAt.getTime() - Date.now()) / 1000,
      )}s out`,
    )

    const tooEarly = await claim('worker-1', ['transcode'])
    assert.equal(tooEarly, null, 'a backed-off job is not claimable before run_at')

    // Bring it forward rather than waiting 30 seconds.
    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, r))
    const second = await claim('worker-1', ['transcode'])
    assert.equal(second?.attempts, 2, 'the second attempt is counted')

    assert.equal(
      await fail(second!.id, new Error('failed again')),
      'dead',
      'exhausting max_attempts parks the job as dead',
    )

    const [dead] = await db.select().from(jobs).where(eq(jobs.id, r))
    assert.equal(dead!.status, 'dead', 'the dead job stays dead')
    assert.ok((dead!.lastError ?? '').includes('failed again'), 'the last error is recorded')
  })

  // --- Permanent failure ----------------------------------------------------
  it('kill() skips the remaining retries without burning attempts', async () => {
    const k = track(await enqueue('transcode', { videoId, objectKey: 'k' }, { dedupeKey: `${tag}:k` }))
    const claimed = await claim('worker-1', ['transcode'])
    await kill(claimed!.id, new Error('file will never decode'))

    const [killed] = await db.select().from(jobs).where(eq(jobs.id, k))
    assert.equal(killed!.status, 'dead')
    assert.equal(killed!.attempts, 1)
  })

  // --- Reaper ---------------------------------------------------------------
  it('the reaper leaves a heartbeating job alone and requeues a stale one', async () => {
    const s = track(await enqueue('transcode', { videoId, objectKey: 's' }, { dedupeKey: `${tag}:s` }))
    const claimed = await claim('worker-1', ['transcode'])

    // A live job that is heartbeating must survive the reaper.
    await heartbeat(claimed!.id, 42)
    assert.equal(await reap(120), 0, 'the reaper leaves a heartbeating job alone')

    // Simulate a worker that died mid-encode.
    await db
      .update(jobs)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(jobs.id, s))

    assert.equal(await reap(120), 1, 'the reaper requeues a job whose heartbeat went stale')

    const [revived] = await db.select().from(jobs).where(eq(jobs.id, s))
    assert.equal(revived!.status, 'queued', 'the reaped job is claimable again')
    assert.equal(revived!.lockedBy, null, 'the reaped job releases its worker lock')
  })

  // --- Progress -------------------------------------------------------------
  it('progress is clamped to 100', async () => {
    const p = track(await enqueue('transcode', { videoId, objectKey: 'pr' }, { dedupeKey: `${tag}:pr` }))
    await db.update(jobs).set({ status: 'running', heartbeatAt: new Date() }).where(eq(jobs.id, p))
    await heartbeat(p, 150)

    const [clamped] = await db.select().from(jobs).where(eq(jobs.id, p))
    assert.equal(clamped!.progress, 100)
  })
})
