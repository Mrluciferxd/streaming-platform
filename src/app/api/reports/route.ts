import { z } from 'zod'

import { getSessionUser } from '@/lib/auth/session'
import { commentIsReportable, createReport, videoIsReportable } from '@/lib/queries/reports'

export const dynamic = 'force-dynamic'

const REASONS = [
  'wrong_classification',
  'breaches_code_of_ethics',
  'accessibility',
  'privacy_complaint',
  'copyright',
  'other',
] as const

const bodySchema = z.object({
  videoId: z.uuid().nullable().optional(),
  commentId: z.uuid().nullable().optional(),
  reason: z.enum(REASONS),
  detail: z.string().trim().min(3).max(20_000),
  /** Anonymous filers may leave an email; signed-in filers' id is recorded. */
  reporterEmail: z.string().email().max(320).nullable().optional(),
})

/**
 * File a grievance (public intake).
 *
 * The IT Rules 2021 mechanism is open — the Grievance Officer cannot refuse a
 * complaint for want of an account. So this endpoint is unauthenticated: an
 * anonymous filer leaves an email (optional, but the Officer needs a way back
 * to them); a signed-in filer's id is recorded for the audit trail.
 *
 * A report targets a video, a comment, or neither (a general complaint). At
 * least one of `videoId`/`commentId` is required — a report has to be *about*
 * something. When a target IS given it must exist and be currently visible:
 * a report on a taken-down video is redundant, and a report on a hidden
 * comment is already actioned.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const { videoId, commentId, reason, detail, reporterEmail } = parsed.data

  // A report has to be about *something*.
  if (!videoId && !commentId) {
    return Response.json({ error: 'nothing_targeted' }, { status: 400 })
  }

  // Validate the target, if given.
  if (videoId && !(await videoIsReportable(videoId))) {
    return Response.json({ error: 'video_not_reportable' }, { status: 404 })
  }
  if (commentId && !(await commentIsReportable(commentId))) {
    return Response.json({ error: 'comment_not_reportable' }, { status: 404 })
  }

  const user = await getSessionUser()

  const result = await createReport({
    videoId: videoId ?? null,
    commentId: commentId ?? null,
    reporterId: user?.id ?? null,
    reporterEmail: user ? null : (reporterEmail ?? null),
    reason,
    detail,
  })

  return Response.json(
    { id: result.id, ok: true },
    {
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
