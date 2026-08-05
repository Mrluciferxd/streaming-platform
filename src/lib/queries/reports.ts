import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'

import { comments, db, reports, videos } from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'

export type ReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed'

export type ReportRow = {
  id: string
  videoId: string | null
  videoTitle: string | null
  commentId: string | null
  commentBody: string | null
  reporterEmail: string | null
  reason: string
  detail: string | null
  status: ReportStatus
  dueAt: Date
  resolvedAt: Date | null
  resolutionNote: string | null
  createdAt: Date
}

/**
 * Grievance reports under the IT Rules 2021.
 *
 * The Grievance Officer has 15 days to resolve a complaint (the default
 * `due_at = now() + interval '15 days'` carries the deadline). The partial
 * index `reports_open_due_idx` on `due_at` where `status in ('open',
 * 'reviewing')` is what the triage queue reads — the overdue queue is a plain
 * index scan, not a computed filter someone has to remember.
 *
 * A report targets either a video or a comment (or neither, for a general
 * complaint). Anonymous filing is allowed — a reporter who is not signed in
 * leaves a `reporter_email` instead — because the Rules do not let the
 * Officer refuse a complaint for want of an account.
 */
export async function listOpenReports(): Promise<ReportRow[]> {
  const rows = await db
    .select({
      id: reports.id,
      videoId: reports.videoId,
      videoTitle: videos.title,
      commentId: reports.commentId,
      commentBody: comments.body,
      reporterEmail: reports.reporterEmail,
      reason: reports.reason,
      detail: reports.detail,
      status: reports.status,
      dueAt: reports.dueAt,
      resolvedAt: reports.resolvedAt,
      resolutionNote: reports.resolutionNote,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .leftJoin(videos, eq(videos.id, reports.videoId))
    .leftJoin(comments, eq(comments.id, reports.commentId))
    .where(or(eq(reports.status, 'open'), eq(reports.status, 'reviewing')))
    .orderBy(asc(reports.dueAt), asc(reports.createdAt))

  return rows.map((r) => ({
    id: r.id,
    videoId: r.videoId,
    videoTitle: r.videoTitle,
    commentId: r.commentId,
    commentBody: r.commentBody,
    reporterEmail: r.reporterEmail,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    dueAt: r.dueAt,
    resolvedAt: r.resolvedAt,
    resolutionNote: r.resolutionNote,
    createdAt: r.createdAt,
  }))
}

/**
 * One report (for the triage detail view). Returns null if the id does not
 * exist; the caller decides what that maps to.
 */
export async function getReport(id: string): Promise<ReportRow | null> {
  const [row] = await db
    .select({
      id: reports.id,
      videoId: reports.videoId,
      videoTitle: videos.title,
      commentId: reports.commentId,
      commentBody: comments.body,
      reporterEmail: reports.reporterEmail,
      reason: reports.reason,
      detail: reports.detail,
      status: reports.status,
      dueAt: reports.dueAt,
      resolvedAt: reports.resolvedAt,
      resolutionNote: reports.resolutionNote,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .leftJoin(videos, eq(videos.id, reports.videoId))
    .leftJoin(comments, eq(comments.id, reports.commentId))
    .where(eq(reports.id, id))
    .limit(1)

  if (!row) return null
  return {
    id: row.id,
    videoId: row.videoId,
    videoTitle: row.videoTitle,
    commentId: row.commentId,
    commentBody: row.commentBody,
    reporterEmail: row.reporterEmail,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    dueAt: row.dueAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
  }
}

/**
 * File a report. Either `videoId` or `commentId` may be null (a general
 * complaint), but not both — a report has to be *about* something.
 *
 * `reporterId` is nullable (anonymous filing) but a signed-in reporter's id
 * is recorded for the audit trail and so a follow-up can reach them.
 */
export async function createReport(input: {
  videoId?: string | null
  commentId?: string | null
  reporterId?: string | null
  reporterEmail?: string | null
  reason: string
  detail?: string | null
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(reports)
    .values({
      videoId: input.videoId ?? null,
      commentId: input.commentId ?? null,
      reporterId: input.reporterId ?? null,
      reporterEmail: input.reporterEmail ?? null,
      reason: input.reason,
      detail: input.detail ?? null,
      // status defaults to 'open'; due_at defaults to now()+15d.
    })
    .returning({ id: reports.id })

  if (!row) throw new Error('insert returned no row')
  return { id: row.id }
}

/**
 * Move a report through triage. `reviewing` is the intermediate "I have eyes
 * on it" state; `actioned` and `dismissed` are the terminal states.
 *
 * Transitioning to a terminal state stamps `resolved_at` and writes the
 * resolution note, which is the record the Rules require. Re-opening a
 * resolved report clears both — the 15-day clock does not restart, but the
 * audit trail shows the full history.
 */
export async function updateReportStatus(
  id: string,
  next: ReportStatus,
  resolutionNote: string | null,
): Promise<ReportRow | null> {
  const terminal = next === 'actioned' || next === 'dismissed'
  const now = new Date()

  await db
    .update(reports)
    .set({
      status: next,
      resolvedAt: terminal ? now : null,
      resolutionNote: terminal ? (resolutionNote ?? null) : null,
    })
    .where(eq(reports.id, id))

  return getReport(id)
}

/**
 * The count of overdue open/reviewing reports — for the queue header so the
 * officer sees the worst number first. Reads the partial index.
 */
export async function countOverdue(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reports)
    .where(and(or(eq(reports.status, 'open'), eq(reports.status, 'reviewing')), sql`${reports.dueAt} < now()`))
  return row?.count ?? 0
}

/**
 * Guard: a report may target a published video (a taken-down video is no
 * longer the public's to complain about). Used by the public intake endpoint.
 */
export async function videoIsReportable(videoId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: videos.id })
    .from(videos)
    .where(and(eq(videos.id, videoId), publiclyVisible))
    .limit(1)
  return Boolean(row)
}

/**
 * Guard for comment reports: the comment must be visible. A hidden comment is
 * already actioned — a fresh report on it is redundant.
 */
export async function commentIsReportable(commentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.status, 'visible'), isNotNull(comments.videoId), isNull(comments.parentId)))
    .limit(1)
  return Boolean(row)
}
