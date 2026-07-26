import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'

import { sqlClient } from '@/db'
import { env } from '@/lib/env'
import {
  claim,
  complete,
  fail,
  heartbeat,
  HEARTBEAT_INTERVAL_MS,
  kill,
  purgeCompleted,
  reap,
  type ClaimedJob,
  type TranscodePayload,
} from '@/lib/jobs/queue'
import { markVideoFailed, PermanentTranscodeError, runTranscode } from './transcode'

/**
 * Transcode worker.
 *
 *   npm run worker
 *
 * Stateless and horizontally scalable: run as many as there are machines. They
 * coordinate purely through `SELECT … FOR UPDATE SKIP LOCKED`, so no worker
 * needs to know another exists.
 */

const WORKER_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
const IDLE_POLL_MS = 2_000
const MAINTENANCE_INTERVAL_MS = 60_000

let shuttingDown = false
let activeJobs = 0

function log(message: string, extra: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), worker: WORKER_ID, message, ...extra }),
  )
}

/**
 * Runs one job with a heartbeat ticking alongside it.
 *
 * Without this the reaper cannot distinguish a 20-minute encode from a worker
 * that was OOM-killed, and would either requeue live jobs or leave dead ones
 * parked indefinitely.
 */
async function runWithHeartbeat(job: ClaimedJob): Promise<void> {
  let latestProgress = 0

  const ticker = setInterval(() => {
    heartbeat(job.id, latestProgress).catch((error) => {
      log('heartbeat failed', { jobId: job.id, error: String(error) })
    })
  }, HEARTBEAT_INTERVAL_MS)

  try {
    switch (job.kind) {
      case 'transcode': {
        const payload = job.payload as TranscodePayload
        let lastLogged = -1

        await runTranscode(payload, (percent, stage) => {
          latestProgress = percent
          const decile = Math.floor(percent / 10)
          if (decile > lastLogged) {
            lastLogged = decile
            log('progress', { jobId: job.id, stage, percent: Math.round(percent) })
          }
        })
        break
      }

      default:
        throw new PermanentTranscodeError(`Unknown job kind: ${job.kind}`)
    }
  } finally {
    clearInterval(ticker)
  }
}

async function handle(job: ClaimedJob): Promise<void> {
  activeJobs++
  const started = Date.now()
  log('job started', { jobId: job.id, kind: job.kind, attempt: job.attempts })

  try {
    await runWithHeartbeat(job)
    await complete(job.id)
    log('job completed', { jobId: job.id, seconds: Math.round((Date.now() - started) / 1000) })
  } catch (error) {
    const permanent = error instanceof PermanentTranscodeError

    // A file that will not decode will not decode on attempt three either.
    const outcome = permanent ? (await kill(job.id, error), 'dead') : await fail(job.id, error)

    if (job.kind === 'transcode') {
      const { videoId } = job.payload as { videoId: string }
      // Only flip the video to failed once retries are genuinely exhausted —
      // otherwise a transient R2 blip would show the creator a failed upload
      // that is about to succeed.
      if (permanent || job.attempts >= job.maxAttempts) {
        await markVideoFailed(videoId).catch(() => {})
      }
    }

    log('job failed', {
      jobId: job.id,
      outcome,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    activeJobs--
  }
}

async function maintenance(): Promise<void> {
  try {
    const requeued = await reap()
    if (requeued > 0) log('reaped stale jobs', { count: requeued })

    const purged = await purgeCompleted()
    if (purged > 0) log('purged completed jobs', { count: purged })
  } catch (error) {
    log('maintenance failed', { error: String(error) })
  }
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    let job: ClaimedJob | null = null

    try {
      job = await claim(WORKER_ID, ['transcode'])
    } catch (error) {
      log('claim failed', { error: String(error) })
      await sleep(IDLE_POLL_MS)
      continue
    }

    if (!job) {
      await sleep(IDLE_POLL_MS)
      continue
    }

    await handle(job)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Finish the job in hand before exiting. A SIGTERM mid-encode would otherwise
 * leave the job locked until the reaper's timeout, delaying it by minutes on
 * every deploy.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down', { signal, activeJobs })

  const deadline = Date.now() + 5 * 60_000
  while (activeJobs > 0 && Date.now() < deadline) await sleep(500)

  if (activeJobs > 0) {
    log('forcing exit with jobs still running; the reaper will requeue them', { activeJobs })
  }

  await sqlClient.end({ timeout: 5 }).catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await mkdir(env.WORKER_TMP_DIR, { recursive: true })

log('worker started', {
  provider: env.VIDEO_PROVIDER,
  concurrency: env.WORKER_CONCURRENCY,
  tmpDir: env.WORKER_TMP_DIR,
})

setInterval(() => void maintenance(), MAINTENANCE_INTERVAL_MS)
void maintenance()

// Concurrency is per-process. One transcode already saturates ~8 vCPU
// (plan §5), so raising this above 1 usually means adding a machine instead.
await Promise.all(Array.from({ length: env.WORKER_CONCURRENCY }, loop))
