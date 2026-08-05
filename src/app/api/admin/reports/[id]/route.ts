import { z } from 'zod'

import { requireAdminApi } from '@/lib/auth/require-role'
import { getReport, updateReportStatus, type ReportStatus } from '@/lib/queries/reports'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const actionSchema = z.discriminatedUnion('action', [
  // Acknowledge and start work. Available from 'open'.
  z.object({ action: z.literal('review') }),
  // The two terminal outcomes. A resolution note is required — the Rules
  // require the Officer to record the outcome, not just that one occurred.
  z.object({
    action: z.literal('action'),
    note: z.string().trim().min(3).max(20_000),
  }),
  z.object({
    action: z.literal('dismiss'),
    note: z.string().trim().min(3).max(20_000),
  }),
  // Re-open a resolved report. Clears resolvedAt + resolutionNote.
  z.object({ action: z.literal('reopen') }),
])

const STATUS_BY_ACTION: Record<'review' | 'action' | 'dismiss' | 'reopen', ReportStatus> = {
  review: 'reviewing',
  action: 'actioned',
  dismiss: 'dismissed',
  reopen: 'open',
}

/**
 * Triage actions on a single grievance report.
 *
 * The status graph: open -> reviewing -> (actioned | dismissed). Reopen
 * returns a terminal report to `open` and clears the resolution fields, so a
 * report that was dismissed prematurely can be re-examined — the audit trail
 * shows the full history in `reports` itself, not in `audit_log`.
 */
export async function POST(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const existing = await getReport(id)
  if (!existing) return Response.json({ error: 'not_found' }, { status: 404 })

  // Enforce the state machine. A report already in a terminal state cannot
  // be acted on again except via reopen; an open report cannot skip
  // reviewing straight to a terminal state... except that the Rules do not
  // forbid it, and an obvious grievance can be actioned in one step.
  // We permit: review (from open, reviewing), action/dismiss (from any non-terminal),
  // reopen (from actioned/dismissed).
  const next = STATUS_BY_ACTION[parsed.data.action]
  const fromTerminal = existing.status === 'actioned' || existing.status === 'dismissed'

  if (parsed.data.action !== 'reopen' && fromTerminal) {
    return conflict('already_resolved')
  }
  if (parsed.data.action === 'reopen' && !fromTerminal) {
    return conflict('not_resolved')
  }

  const note = parsed.data.action === 'action' || parsed.data.action === 'dismiss' ? parsed.data.note : null
  const updated = await updateReportStatus(id, next, note)
  if (!updated) return Response.json({ error: 'not_found' }, { status: 404 })

  return Response.json(
    { ok: true, status: updated.status },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

function conflict(reason: string): Response {
  return Response.json({ error: reason }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
}
