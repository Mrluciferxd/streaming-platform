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
import { eq, inArray, sql } from 'drizzle-orm'

import { db, jobs, sqlClient } from '../src/db/index.ts'
import {
  claim,
  complete,
  enqueue,
  fail,
  heartbeat,
  kill,
  reap,
} from '../src/lib/jobs/queue.ts'

let failures = 0
const created: number[] = []

function check(ok: boolean, label: string, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const tag = `check-${Date.now()}`
const videoId = '00000000-0000-4000-8000-000000000001'

function track(id: number | null): number {
  if (id === null) throw new Error('expected an enqueued job id')
  created.push(id)
  return id
}

try {
  // --- Enqueue and claim ----------------------------------------------------
  const a = track(
    await enqueue('transcode', { videoId, objectKey: 'a' }, { dedupeKey: `${tag}:a` }),
  )

  const claimed = await claim('worker-1', ['transcode'])
  check(claimed?.id === a, 'a queued job can be claimed', `got ${claimed?.id}`)
  check(claimed?.attempts === 1, 'claiming increments the attempt counter')

  // --- No double delivery ---------------------------------------------------
  const second = await claim('worker-2', ['transcode'])
  check(second === null, 'a running job is never handed to a second worker')

  // --- Concurrent claims ----------------------------------------------------
  // The real test of SKIP LOCKED: many workers racing for a small pool of jobs
  // must partition them, never duplicate them.
  await complete(a)

  const poolSize = 8
  for (let i = 0; i < poolSize; i++) {
    track(await enqueue('transcode', { videoId, objectKey: `p${i}` }, { dedupeKey: `${tag}:p${i}` }))
  }

  const racers = await Promise.all(
    Array.from({ length: 20 }, (_, i) => claim(`racer-${i}`, ['transcode'])),
  )
  const won = racers.filter((j): j is NonNullable<typeof j> => j !== null)
  const uniqueIds = new Set(won.map((j) => j.id))

  check(won.length === poolSize, '20 concurrent claimers get exactly the 8 available jobs', `${won.length} claimed`)
  check(uniqueIds.size === won.length, 'no job is claimed twice', `${uniqueIds.size} unique of ${won.length}`)

  for (const j of won) await complete(j.id)

  // --- Dedupe ---------------------------------------------------------------
  const d1 = track(await enqueue('transcode', { videoId, objectKey: 'd' }, { dedupeKey: `${tag}:d` }))
  const d2 = await enqueue('transcode', { videoId, objectKey: 'd' }, { dedupeKey: `${tag}:d` })
  check(d2 === null, 'a live job with the same dedupe key is not re-enqueued')

  const dClaimed = await claim('worker-1', ['transcode'])
  const d3 = await enqueue('transcode', { videoId, objectKey: 'd' }, { dedupeKey: `${tag}:d` })
  check(d3 === null, 'dedupe still holds while the job is running')

  await complete(dClaimed!.id)
  const d4 = await enqueue('transcode', { videoId, objectKey: 'd' }, { dedupeKey: `${tag}:d` })
  check(d4 !== null, 'the same key can be enqueued again once the job finished')
  track(d4)
  await complete((await claim('worker-1', ['transcode']))!.id)
  void d1

  // --- Retry and backoff ----------------------------------------------------
  const r = track(
    await enqueue('transcode', { videoId, objectKey: 'r' }, { dedupeKey: `${tag}:r`, maxAttempts: 2 }),
  )

  const r1 = await claim('worker-1', ['transcode'])
  const outcome1 = await fail(r1!.id, new Error('transient R2 error'))
  check(outcome1 === 'retry', 'a failure below max_attempts retries')

  const [afterFail] = await db.select().from(jobs).where(eq(jobs.id, r))
  check(afterFail!.status === 'queued', 'a retrying job returns to queued')
  check(
    afterFail!.runAt.getTime() > Date.now() + 20_000,
    'retry is delayed by backoff, not immediate',
    `runAt is ${Math.round((afterFail!.runAt.getTime() - Date.now()) / 1000)}s out`,
  )

  const tooEarly = await claim('worker-1', ['transcode'])
  check(tooEarly === null, 'a backed-off job is not claimable before run_at')

  // Bring it forward rather than waiting 30 seconds.
  await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, r))
  const r2 = await claim('worker-1', ['transcode'])
  check(r2?.attempts === 2, 'the second attempt is counted', `attempts=${r2?.attempts}`)

  const outcome2 = await fail(r2!.id, new Error('failed again'))
  check(outcome2 === 'dead', 'exhausting max_attempts parks the job as dead')

  const [dead] = await db.select().from(jobs).where(eq(jobs.id, r))
  check(dead!.status === 'dead', 'the dead job stays dead')
  check((dead!.lastError ?? '').includes('failed again'), 'the last error is recorded')

  // --- Permanent failure ----------------------------------------------------
  const k = track(await enqueue('transcode', { videoId, objectKey: 'k' }, { dedupeKey: `${tag}:k` }))
  const kClaimed = await claim('worker-1', ['transcode'])
  await kill(kClaimed!.id, new Error('file will never decode'))

  const [killed] = await db.select().from(jobs).where(eq(jobs.id, k))
  check(killed!.status === 'dead', 'kill() skips the remaining retries')
  check(killed!.attempts === 1, 'kill() does not burn attempts first', `attempts=${killed!.attempts}`)

  // --- Reaper ---------------------------------------------------------------
  const s = track(await enqueue('transcode', { videoId, objectKey: 's' }, { dedupeKey: `${tag}:s` }))
  const sClaimed = await claim('worker-1', ['transcode'])

  // A live job that is heartbeating must survive the reaper.
  await heartbeat(sClaimed!.id, 42)
  const reapedLive = await reap(120)
  check(reapedLive === 0, 'the reaper leaves a heartbeating job alone')

  // Simulate a worker that died mid-encode.
  await db
    .update(jobs)
    .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(jobs.id, s))

  const reapedDead = await reap(120)
  check(reapedDead === 1, 'the reaper requeues a job whose heartbeat went stale', `${reapedDead} reaped`)

  const [revived] = await db.select().from(jobs).where(eq(jobs.id, s))
  check(revived!.status === 'queued', 'the reaped job is claimable again')
  check(revived!.lockedBy === null, 'the reaped job releases its worker lock')

  // --- Progress -------------------------------------------------------------
  const p = track(await enqueue('transcode', { videoId, objectKey: 'pr' }, { dedupeKey: `${tag}:pr` }))
  await db.update(jobs).set({ status: 'running', heartbeatAt: new Date() }).where(eq(jobs.id, p))
  await heartbeat(p, 150)
  const [clamped] = await db.select().from(jobs).where(eq(jobs.id, p))
  check(clamped!.progress === 100, 'progress is clamped to 100', `got ${clamped!.progress}`)
} finally {
  if (created.length > 0) {
    await db.delete(jobs).where(inArray(jobs.id, created))
  }
  // Anything this run left behind, in case of an early throw.
  await db.delete(jobs).where(sql`${jobs.dedupeKey} like ${`${tag}:%`}`)
  await sqlClient.end()
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
