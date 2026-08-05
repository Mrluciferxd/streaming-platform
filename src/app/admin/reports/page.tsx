import type { Metadata } from 'next'

import { ReportActions } from './ReportActions'
import { Empty, Panel, Pill, formatDateTime } from '../ui'
import { requireAdminPage } from '@/lib/auth/require-role'
import { countOverdue, listOpenReports } from '@/lib/queries/reports'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Grievance queue' }

/**
 * Grievance Officer's triage queue.
 *
 * IT Rules 2021 gives 15 days from filing to resolution, and the schema
 * stamps `due_at = now() + interval '15 days'` on every row. This queue reads
 * the partial index `reports_open_due_idx` (open/reviewing, ordered by
 * due_at) so the officer sees the soonest-due first and the overdue count is
 * a single index scan, not a computed filter.
 *
 * Statuses: open -> reviewing -> (actioned | dismissed). `reopen` returns a
 * terminal report to open. The state machine is enforced in the API.
 */
export default async function AdminReportsPage() {
  const user = await requireAdminPage()

  const [reports, overdue] = await Promise.all([listOpenReports(), countOverdue()])

  return (
    <Panel
      title="Grievance queue"
      hint={
        reports.length === 0
          ? 'Nothing open right now'
          : `${reports.length} open · ${overdue > 0 ? `${overdue} overdue` : 'none overdue'}`
      }
    >
      {overdue > 0 ? (
        <div className="border-b border-primary/30 bg-primary-soft px-5 py-3 text-sm font-bold text-primary">
          {overdue} report{overdue === 1 ? '' : 's'} past the 15-day deadline — action these first.
        </div>
      ) : null}

      {reports.length === 0 ? (
        <Empty>No open grievance reports.</Empty>
      ) : (
        <div className="divide-y divide-line">
          {reports.map((report) => {
            const isOverdue = report.dueAt.getTime() < Date.now()
            return (
              <article key={report.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill value={report.status} />
                  {isOverdue ? <Pill value="overdue" /> : null}
                  <span className="text-xs text-muted">
                    Filed {formatDateTime(report.createdAt)} · due {formatDateTime(report.dueAt)}
                  </span>
                </div>

                <div className="mt-2">
                  <p className="text-sm font-bold text-ink">{humanReason(report.reason)}</p>
                  {report.detail ? (
                    <p className="mt-1 max-w-2xl whitespace-pre-line text-sm leading-relaxed text-ink-soft">
                      {report.detail}
                    </p>
                  ) : null}
                </div>

                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  {report.videoTitle ? (
                    <div>
                      <dt className="inline font-bold text-muted">Video: </dt>
                      <dd className="inline text-ink-soft">{report.videoTitle}</dd>
                    </div>
                  ) : null}
                  {report.commentBody ? (
                    <div className="sm:col-span-2">
                      <dt className="inline font-bold text-muted">Comment: </dt>
                      <dd className="inline text-ink-soft">
                        &ldquo;{report.commentBody.length > 140 ? `${report.commentBody.slice(0, 140)}…` : report.commentBody}&rdquo;
                      </dd>
                    </div>
                  ) : null}
                  {report.reporterEmail ? (
                    <div>
                      <dt className="inline font-bold text-muted">Reporter: </dt>
                      <dd className="inline text-ink-soft">{report.reporterEmail}</dd>
                    </div>
                  ) : (
                    <div>
                      <dt className="inline font-bold text-muted">Reporter: </dt>
                      <dd className="inline text-ink-soft">signed-in user</dd>
                    </div>
                  )}
                </dl>

                <ReportActions reportId={report.id} status={report.status} />
              </article>
            )
          })}
        </div>
      )}

      <p className={`px-5 py-3 text-xs text-muted ${reports.length === 0 ? '' : 'border-t border-line'}`}>
        Resolved reports keep their resolution note and timestamp on the row; the audit trail is
        the reports table itself, not <code>audit_log</code>. Reopening a resolved report clears
        the resolution fields but preserves the history of statuses on the row.
      </p>
    </Panel>
  )
}

function humanReason(reason: string): string {
  const map: Record<string, string> = {
    wrong_classification: 'Wrong classification',
    breaches_code_of_ethics: 'Breaches the Code of Ethics',
    accessibility: 'Accessibility problem',
    privacy_complaint: 'Privacy / personal data complaint',
    copyright: 'Copyright infringement',
    other: 'Other',
  }
  return map[reason] ?? reason
}
