import { and, eq, lt, sql } from 'drizzle-orm'

import { db, jobs } from '@/db'

/**
 * Postgres-backed job queue. See the comment on the `jobs` table in
 * src/db/schema.ts for why this is not BullMQ.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, so N workers can poll the same table
 * concurrently without ever handing the same row to two of them and without
 * blocking each other.
 */

export type JobKind = 'transcode' | 'cleanup_upload'

export type TranscodePayload = {
  videoId: string
  objectKey: string
}

export type CleanupUploadPayload = {
  uploadId: string
}

export type JobPayloads = {
  transcode: TranscodePayload
  cleanup_upload: CleanupUploadPayload
}

export type ClaimedJob<K extends JobKind = JobKind> = {
  id: number
  kind: K
  payload: JobPayloads[K]
  attempts: number
  maxAttempts: number
}

/** Requeue a `running` job whose worker has not checked in for this long. */
export const STALE_HEARTBEAT_SECONDS = 120
/** How often a running worker should call `heartbeat`. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Either the pooled client or an open transaction.
 *
 * Enqueueing inside the caller's transaction is the whole point of keeping the
 * queue in Postgres: the job and the row it operates on commit together, so
 * there is never a job for work that was rolled back, nor a row waiting on a
 * job that was never written.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function enqueue<K extends JobKind>(
  kind: K,
  payload: JobPayloads[K],
  opts: { priority?: number; maxAttempts?: number; dedupeKey?: string; runAt?: Date } = {},
  executor: Executor = db,
): Promise<number | null> {
  const [row] = await executor
    .insert(jobs)
    .values({
      kind,
      payload,
      priority: opts.priority ?? 0,
      maxAttempts: opts.maxAttempts ?? 3,
      dedupeKey: opts.dedupeKey ?? null,
      runAt: opts.runAt ?? new Date(),
    })
    // Returns null when a live job with the same dedupe key already exists,
    // which is the desired outcome for a double-submitted upload.
    .onConflictDoNothing()
    .returning({ id: jobs.id })

  return row?.id ?? null
}

/**
 * Claim the highest-priority ready job, or null if the queue is empty.
 *
 * The whole thing is one statement so the claim is atomic — there is no window
 * between selecting a row and marking it taken.
 */
export async function claim(
  workerId: string,
  kinds: readonly JobKind[],
): Promise<ClaimedJob | null> {
  const kindList = sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )

  // `id` is declared as string here because this is a raw `db.execute`, which
  // bypasses drizzle's bigint mapping: postgres.js returns int8 as a string to
  // avoid silent precision loss. Typing it as number would compile fine and
  // then hand every caller a string wearing a number's type.
  const rows = await db.execute<{
    id: string
    kind: JobKind
    payload: JobPayloads[JobKind]
    attempts: number
    max_attempts: number
  }>(sql`
    UPDATE jobs
       SET status       = 'running',
           locked_at    = now(),
           locked_by    = ${workerId},
           heartbeat_at = now(),
           attempts     = attempts + 1,
           progress     = 0,
           updated_at   = now()
     WHERE id = (
       SELECT id
         FROM jobs
        WHERE status = 'queued'
          AND run_at <= now()
          AND kind IN (${kindList})
        ORDER BY priority DESC, run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id, kind, payload, attempts, max_attempts
  `)

  const row = rows[0]
  if (!row) return null

  return {
    id: Number(row.id),
    kind: row.kind,
    payload: row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  }
}

/**
 * Keep a long-running job alive and report progress. A transcode runs for
 * minutes, so without this the reaper could not tell it apart from a job whose
 * worker was killed.
 */
export async function heartbeat(jobId: number, progress?: number): Promise<void> {
  await db
    .update(jobs)
    .set({
      heartbeatAt: new Date(),
      updatedAt: new Date(),
      ...(progress === undefined
        ? {}
        : { progress: Math.max(0, Math.min(100, Math.round(progress))) }),
    })
    .where(eq(jobs.id, jobId))
}

export async function complete(jobId: number): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: 'done',
      progress: 100,
      finishedAt: new Date(),
      updatedAt: new Date(),
      lockedBy: null,
      lastError: null,
    })
    .where(eq(jobs.id, jobId))
}

/**
 * Record a failure. Retries with exponential backoff until `maxAttempts`, then
 * parks the job as `dead` for a human rather than looping forever.
 */
export async function fail(jobId: number, error: unknown): Promise<'retry' | 'dead'> {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)

  const rows = await db.execute<{ status: 'queued' | 'dead' }>(sql`
    UPDATE jobs
       SET status     = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status
                             ELSE 'queued'::job_status END,
           -- 30s, 60s, 120s … capped at 10 minutes.
           run_at     = now() + least(
                          make_interval(secs => 30 * power(2, greatest(attempts - 1, 0))::int),
                          interval '10 minutes'
                        ),
           last_error = ${message.slice(0, 8000)},
           locked_by  = NULL,
           locked_at  = NULL,
           finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
           updated_at = now()
     WHERE id = ${jobId}
    RETURNING status
  `)

  return rows[0]?.status === 'dead' ? 'dead' : 'retry'
}

/**
 * Fail a job permanently, skipping the remaining retries.
 *
 * For input that cannot ever succeed — a file that will not decode, an unknown
 * job kind — retrying is pure waste: three attempts at a multi-minute transcode
 * before anyone sees the problem.
 */
export async function kill(jobId: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)

  await db
    .update(jobs)
    .set({
      status: 'dead',
      lastError: message.slice(0, 8000),
      lockedBy: null,
      lockedAt: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId))
}

/**
 * Return jobs whose worker died mid-run to the queue. Run periodically from any
 * worker — it is safe to run concurrently on several.
 */
export async function reap(staleAfterSeconds = STALE_HEARTBEAT_SECONDS): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE jobs
       SET status     = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status
                             ELSE 'queued'::job_status END,
           last_error = 'worker heartbeat went stale; requeued by reaper',
           locked_by  = NULL,
           locked_at  = NULL,
           run_at     = now(),
           updated_at = now()
     WHERE status = 'running'
       AND heartbeat_at < now() - make_interval(secs => ${staleAfterSeconds})
    RETURNING id
  `)

  return rows.length
}

/** Operational visibility: what is queued, running, and dead right now. */
export async function stats(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status)

  return Object.fromEntries(rows.map((r) => [r.status, r.count]))
}

/** Jobs parked for a human, newest first. */
export async function deadLetters(limit = 50) {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.status, 'dead'))
    .orderBy(sql`${jobs.createdAt} desc`)
    .limit(limit)
}

/** Push a dead job back into the queue after the underlying cause is fixed. */
export async function retryDead(jobId: number): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'queued', attempts: 0, runAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'dead')))
}

/** Keep the table small. Completed jobs are only useful for a short window. */
export async function purgeCompleted(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000)
  const rows = await db
    .delete(jobs)
    .where(and(eq(jobs.status, 'done'), lt(jobs.finishedAt, cutoff)))
    .returning({ id: jobs.id })

  return rows.length
}
