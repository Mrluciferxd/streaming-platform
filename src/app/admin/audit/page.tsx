import type { Metadata } from 'next'
import Link from 'next/link'

import { Empty, Panel, formatDateTime } from '../ui'
import { requireAdminPage } from '@/lib/auth/require-role'
import { listAuditLog } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Audit log' }

type Search = Record<string, string | string[] | undefined>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/**
 * The IT Rules compliance trail.
 *
 * When a 36-hour removal order is questioned, the answer has to be a record of
 * who removed what and when. Append-only by convention — nothing in the app
 * updates or deletes a row here, and nothing should.
 */
export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireAdminPage()

  const entity = first((await searchParams).entity)
  const filter = entity && /^[0-9a-f-]{36}$/i.test(entity) ? entity : undefined
  const entries = await listAuditLog(200, filter)

  return (
    <Panel
      title="Audit log"
      hint={filter ? `Filtered to one entity · ${entries.length} entries` : `Last ${entries.length} privileged actions`}
      actions={
        filter ? (
          <Link href="/admin/audit" className="text-xs font-bold text-muted hover:text-primary">
            Clear filter
          </Link>
        ) : null
      }
    >
      {entries.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                <th className="px-5 py-2.5">When</th>
                <th className="px-3 py-2.5">Actor</th>
                <th className="px-3 py-2.5">Action</th>
                <th className="px-3 py-2.5">Entity</th>
                <th className="px-5 py-2.5">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-line/70 align-top last:border-0">
                  <td className="px-5 py-2.5 text-xs whitespace-nowrap text-muted">
                    {formatDateTime(entry.createdAt)}
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    <span className="font-bold text-ink">{entry.actorName ?? 'system'}</span>
                    {entry.ip ? <span className="block text-muted">{entry.ip}</span> : null}
                  </td>
                  <td className="px-3 py-2.5 text-xs font-bold text-ink-soft">{entry.action}</td>
                  <td className="px-3 py-2.5 text-xs">
                    {entry.entityType === 'video' && entry.entityId ? (
                      <Link href={`/admin/videos/${entry.entityId}`} className="font-bold text-primary hover:underline">
                        video
                      </Link>
                    ) : (
                      <span className="text-muted">{entry.entityType}</span>
                    )}
                    {entry.entityId ? (
                      <Link
                        href={`/admin/audit?entity=${entry.entityId}`}
                        className="mt-0.5 block truncate font-mono text-[10px] text-muted hover:text-primary"
                      >
                        {entry.entityId.slice(0, 8)}…
                      </Link>
                    ) : null}
                  </td>
                  <td className="max-w-md px-5 py-2.5">
                    <Diff before={entry.before} after={entry.after} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

/**
 * Only the keys that actually moved.
 *
 * A raw before/after dump of a video row is unreadable and buries the one field
 * that changed — usually the status, which is the whole reason the row exists.
 */
function Diff({ before, after }: { before: unknown; after: unknown }) {
  const a = asRecord(before)
  const b = asRecord(after)
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]

  const changed = keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
  if (changed.length === 0) {
    return <span className="text-xs text-muted">no field changes recorded</span>
  }

  return (
    <ul className="space-y-0.5 text-[11px]">
      {changed.map((key) => (
        <li key={key} className="truncate">
          <span className="font-bold text-ink-soft">{key}</span>{' '}
          {key in a ? <span className="text-muted line-through">{show(a[key])}</span> : null}{' '}
          {key in b ? <span className="text-ink">{show(b[key])}</span> : null}
        </li>
      ))}
    </ul>
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '∅'
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 60)}…` : value
  return JSON.stringify(value)
}
