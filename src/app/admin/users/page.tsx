import type { Metadata } from 'next'
import Link from 'next/link'

import { UserActions } from './UserActions'
import { Empty, Panel, Pill, button, field, formatCount, formatDateTime } from '../ui'
import { requireAdminPage } from '@/lib/auth/require-role'
import { listUsers, type UserRole } from '@/lib/queries/users'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Users' }

type Search = Record<string, string | string[] | undefined>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

const ROLE_OPTIONS = ['viewer', 'creator', 'moderator', 'admin', 'deleted'] as const
const ROLE_FILTERS: ReadonlySet<string> = new Set(ROLE_OPTIONS)

/**
 * Operator's user roster.
 *
 * The list mirrors the audit mindset: soft-deleted accounts stay in the table
 * so an audit row keeps an actor name behind it, but their PII (email, phone,
 * avatar, password hash) is nulled at delete time to honour a DPDP Act 2023
 * erasure request. The "deleted" filter re-surfaces those rows for restore.
 *
 * Role change and soft delete are the two operator actions; both hit the
 * `[id]` route which enforces the last-admin guard — there is no path here to
 * demote yourself into a lockout.
 */
export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireAdminPage()

  const params = await searchParams
  const query = first(params.query)
  const roleRaw = first(params.role)
  const pageRaw = first(params.page)

  const role: UserRole | 'deleted' | undefined =
    roleRaw && ROLE_FILTERS.has(roleRaw) ? (roleRaw as UserRole | 'deleted') : undefined

  const page = Math.max(1, Number.parseInt(pageRaw ?? '', 10) || 1)

  const { items, total, page: currentPage, perPage } = await listUsers({ query, role, page })

  const isLastPage = currentPage * perPage >= total

  // Preserve the active filter when paging.
  const qs = (next: Record<string, string | number | undefined>) => {
    const pairs = Object.entries({ query, role, ...next })
      .filter(([, v]) => v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v)))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    return pairs.length ? `?${pairs.join('&')}` : ''
  }

  const prevHref = currentPage > 1 ? qs({ page: currentPage - 1 }) : null
  const nextHref = !isLastPage ? qs({ page: currentPage + 1 }) : null

  return (
    <Panel
      title="Users"
      hint={`${formatCount(total)} total · page ${currentPage}${total === 0 ? '' : ` of ${Math.max(1, Math.ceil(total / perPage))}`}`}
    >
      <form method="GET" className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-4">
        <label className="block flex-1 min-w-[12rem]">
          <span className="mb-1 block text-xs font-bold text-ink">Search</span>
          <input
            name="query"
            defaultValue={query ?? ''}
            placeholder="email or display name"
            className={field}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-ink">Role</span>
          <select name="role" defaultValue={role ?? ''} className={field}>
            <option value="">All</option>
            <option value="viewer">viewer</option>
            <option value="creator">creator</option>
            <option value="moderator">moderator</option>
            <option value="admin">admin</option>
            <option value="deleted">deleted</option>
          </select>
        </label>
        <button type="submit" className={button.primary}>
          Filter
        </button>
      </form>

      {items.length === 0 ? (
        <Empty>No users match this filter.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                <th className="px-5 py-2.5">User</th>
                <th className="px-3 py-2.5">Role</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Joined</th>
                <th className="px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((user) => {
                const deleted = user.deletedAt !== null
                return (
                  <tr key={user.id} className="border-b border-line/70 align-top last:border-0">
                    <td className="px-5 py-2.5 text-xs">
                      <span className="font-bold text-ink">{user.displayName}</span>
                      <span className="block text-muted">{user.email ?? '—'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Pill value={user.role} />
                    </td>
                    <td className="px-3 py-2.5">
                      {deleted ? (
                        <Pill value="deleted" />
                      ) : (
                        <Pill value="active" muted />
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted">
                      {formatDateTime(user.createdAt)}
                    </td>
                    <td className="px-5 py-2.5">
                      <UserActions userId={user.id} role={user.role} deleted={deleted} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between px-5 py-3 text-xs text-muted">
        <span>
          {total === 0
            ? 'no results'
            : `${formatCount((currentPage - 1) * perPage + 1)}–${formatCount(Math.min(currentPage * perPage, total))} of ${formatCount(total)}`}
        </span>
        <div className="flex gap-2">
          {prevHref ? (
            <Link href={`/admin/users${prevHref}`} className="font-bold text-primary hover:underline">
              ← Previous
            </Link>
          ) : (
            <span className="font-bold text-muted/60">← Previous</span>
          )}
          {nextHref ? (
            <Link href={`/admin/users${nextHref}`} className="font-bold text-primary hover:underline">
              Next →
            </Link>
          ) : (
            <span className="font-bold text-muted/60">Next →</span>
          )}
        </div>
      </div>
    </Panel>
  )
}
