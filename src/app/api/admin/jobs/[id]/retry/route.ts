import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, jobs } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { retryDead } from '@/lib/jobs/queue'
import { recordAudit } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * Push a dead job back into the queue.
 *
 * Only meaningful after the underlying cause is fixed — a file that will not
 * decode fails again in exactly the same way, three more times. The dead-letter
 * view shows `last_error` next to this button for that reason.
 */
export async function POST(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const id = Number((await params).id)
  if (!Number.isSafeInteger(id) || id <= 0) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1)
  if (!job) return Response.json({ error: 'not_found' }, { status: 404 })
  if (job.status !== 'dead') {
    return Response.json({ error: 'job_not_dead', status: job.status }, { status: 409 })
  }

  await retryDead(id)

  const payload = z
    .object({ videoId: z.uuid() })
    .safeParse(job.payload)

  await recordAudit({
    actorId: gate.user.id,
    action: 'job.retry',
    entityType: 'job',
    // The audit table keys on uuid, and the entity an operator cares about is
    // the video, not the queue row. The job id rides along in `after`.
    entityId: payload.success ? payload.data.videoId : null,
    before: { jobId: id, status: 'dead', lastError: job.lastError?.slice(0, 500) ?? null },
    after: { jobId: id, status: 'queued' },
    ip: clientIp(request),
  })

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
