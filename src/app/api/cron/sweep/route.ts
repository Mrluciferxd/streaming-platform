import { and, eq, lt } from 'drizzle-orm'

import { db, jobs, uploads, videos } from '@/db'
import { purgeExpiredSessions } from '@/lib/auth/session'
import { purgeCompleted, reap } from '@/lib/jobs/queue'
import { purgeExpiredRateLimits } from '@/lib/rate-limit'
import { getVideoProvider } from '@/lib/video'
import { isAuthorisedCron, unauthorisedCron } from '../auth'

export const dynamic = 'force-dynamic'
// Each abandoned upload costs a round trip to the storage provider, and a bad
// day could leave a few hundred of them.
export const maxDuration = 60

/**
 * Housekeeping for everything that expires.
 *
 * The one that costs money is the first. `uploads.expires_at` has been set
 * since Phase 2 and nothing ever acted on it: a client that vanishes mid-upload
 * leaves its S3 multipart parts on the bucket, and those parts bill as storage
 * indefinitely while being invisible in a normal bucket listing — so the bill
 * grows and nothing in the console explains why. Aborting the upload is the
 * only thing that releases them.
 *
 * The rest is table hygiene: expired sessions, spent rate-limit counters, jobs
 * whose worker died, and finished job history.
 *
 * Every step is independent and each records its own error, because a provider
 * outage must not stop sessions being purged. The run reports `ok: false` if
 * any step failed, so a monitored cron actually surfaces it.
 */

/** Bounded so one run cannot exceed maxDuration. The next run takes the rest. */
const MAX_UPLOADS_PER_RUN = 200

/** Dead jobs are kept this long — long enough to diagnose, not forever. */
const DEAD_JOB_RETENTION_DAYS = 30

export async function GET(request: Request) {
  if (!isAuthorisedCron(request)) return unauthorisedCron()

  const started = Date.now()
  const result: Record<string, unknown> = {}
  const errors: string[] = []

  async function step(name: string, run: () => Promise<unknown>) {
    try {
      result[name] = await run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${name}: ${message}`)
      console.error(`sweep step ${name} failed`, error)
    }
  }

  await step('uploads', sweepAbandonedUploads)
  await step('sessionsPurged', purgeExpiredSessions)
  await step('rateLimitRowsPurged', purgeExpiredRateLimits)
  // Nothing else reaps on a serverless deployment: the reaper normally runs
  // inside a worker process, and there is no worker process here between
  // transcodes.
  await step('jobsRequeued', () => reap())
  await step('doneJobsPurged', () => purgeCompleted(7))
  await step('deadJobsPurged', purgeDeadJobs)

  return Response.json(
    { ok: errors.length === 0, ...result, errors, ms: Date.now() - started },
    { status: errors.length === 0 ? 200 : 500, headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * Abort multipart uploads whose window has closed.
 *
 * Per-upload error handling matters here: one object that the provider refuses
 * to abort must not stop the other 199 from being released. A failed abort
 * leaves the row `pending`, so the next run retries it rather than losing track
 * of parts that are still being billed.
 */
async function sweepAbandonedUploads() {
  const expired = await db
    .select({
      id: uploads.id,
      videoId: uploads.videoId,
      objectKey: uploads.objectKey,
      multipartId: uploads.multipartId,
    })
    .from(uploads)
    .where(and(eq(uploads.status, 'pending'), lt(uploads.expiresAt, new Date())))
    .limit(MAX_UPLOADS_PER_RUN)

  if (expired.length === 0) return { found: 0, aborted: 0, failed: 0 }

  const provider = await getVideoProvider()
  let aborted = 0
  let failed = 0

  for (const upload of expired) {
    try {
      if (upload.multipartId) {
        await provider.abortResumableUpload({
          objectKey: upload.objectKey,
          multipartId: upload.multipartId,
        })
      }

      await db.update(uploads).set({ status: 'aborted' }).where(eq(uploads.id, upload.id))

      /**
       * The video row is created before the upload and left in `uploading`
       * while bytes land. Without this it stays there forever — holding its
       * slug, sitting at the top of the admin list, and occupying the partial
       * unique index that stops a second upload against the same video.
       */
      await db
        .update(videos)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(and(eq(videos.id, upload.videoId), eq(videos.status, 'uploading')))

      aborted++
    } catch (error) {
      failed++
      // Logged per upload rather than thrown: the object key is what an
      // operator needs to find the orphaned parts by hand if this keeps failing.
      console.error(`sweep could not abort upload ${upload.id} (${upload.objectKey})`, error)
    }
  }

  return { found: expired.length, aborted, failed }
}

/**
 * Dead jobs are the only record of why something never transcoded, so they are
 * kept a month rather than purged with the successes. After that they are
 * archaeology.
 */
async function purgeDeadJobs(): Promise<number> {
  const rows = await db
    .delete(jobs)
    .where(
      and(
        eq(jobs.status, 'dead'),
        lt(jobs.finishedAt, new Date(Date.now() - DEAD_JOB_RETENTION_DAYS * 86_400_000)),
      ),
    )
    .returning({ id: jobs.id })

  return rows.length
}
