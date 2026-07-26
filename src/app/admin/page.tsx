import Link from 'next/link'

import { PublishDueButton } from './PublishDueButton'
import { Empty, Meter, Panel, Pill, button, field, formatCount, formatDateTime, formatDuration } from './ui'
import { requireAdminPage } from '@/lib/auth/require-role'
import {
  listAdminVideos,
  VIDEO_STATUSES,
  videoStatusCounts,
  type AdminVideoFilter,
} from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

type Search = Record<string, string | string[] | undefined>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

const FILTERS = [...VIDEO_STATUSES, 'deleted'] as const

export default async function AdminLibraryPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  await requireAdminPage()

  const params = await searchParams
  const rawStatus = first(params.status)
  const status = (FILTERS as readonly string[]).includes(rawStatus ?? '')
    ? (rawStatus as AdminVideoFilter['status'])
    : undefined

  const query = first(params.q) ?? ''
  const language = first(params.lang) ?? ''
  const page = Number(first(params.page) ?? 1) || 1

  const [result, counts] = await Promise.all([
    listAdminVideos({ status, query, language: language || undefined, page }),
    videoStatusCounts(),
  ])

  const href = (next: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams()
    const merged = { status: status ?? '', q: query, lang: language, page, ...next }

    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '' && !(key === 'page' && value === 1)) {
        search.set(key, String(value))
      }
    }

    const qs = search.toString()
    return qs ? `/admin?${qs}` : '/admin'
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip href={href({ status: '', page: 1 })} active={!status} label="All live" />
        {FILTERS.map((value) => (
          <StatusChip
            key={value}
            href={href({ status: value, page: 1 })}
            active={status === value}
            label={value}
            count={counts[value] ?? 0}
          />
        ))}
      </div>

      <Panel
        title={`${formatCount(result.total)} ${result.total === 1 ? 'title' : 'titles'}`}
        hint={status ? `Filtered to ${status}` : 'Everything not soft-deleted'}
        actions={
          <>
            <PublishDueButton />
            <Link href="/admin/upload" className={button.primary}>
              Upload
            </Link>
          </>
        }
      >
        {/* A plain GET form: the filters end up in the URL, so a filtered view
            is linkable and the back button behaves. No JavaScript involved. */}
        <form method="get" className="flex flex-wrap items-end gap-2 border-b border-line px-5 py-3">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <label className="flex-1 basis-56">
            <span className="mb-1 block text-xs font-bold text-ink">Title contains</span>
            <input name="q" defaultValue={query} placeholder="Search titles" className={field} />
          </label>
          <label className="basis-32">
            <span className="mb-1 block text-xs font-bold text-ink">Language</span>
            <input name="lang" defaultValue={language} placeholder="hi" className={field} />
          </label>
          <button type="submit" className={button.ghost}>
            Apply
          </button>
          {query || language ? (
            <Link href={href({ q: '', lang: '', page: 1 })} className="px-2 py-2 text-xs font-bold text-muted hover:text-primary">
              Clear
            </Link>
          ) : null}
        </form>

        {result.rows.length === 0 ? (
          <Empty>No titles match this filter.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[54rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                  <th className="px-5 py-2.5 font-bold">Title</th>
                  <th className="px-3 py-2.5 font-bold">Status</th>
                  <th className="w-44 px-3 py-2.5 font-bold">Transcode</th>
                  <th className="px-3 py-2.5 font-bold">Rating</th>
                  <th className="px-3 py-2.5 text-right font-bold">Views</th>
                  <th className="px-3 py-2.5 font-bold">Updated</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.id} className="border-b border-line/70 last:border-0 hover:bg-mist/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="h-10 w-[3.75rem] shrink-0 overflow-hidden rounded-lg bg-mist">
                          {row.posterUrl ? (
                            // Plain <img>: these are 60px thumbnails behind a
                            // login, so next/image's optimiser would add a
                            // round trip and a cache entry for nothing.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={row.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                          ) : null}
                        </span>
                        <span className="min-w-0">
                          <Link
                            href={`/admin/videos/${row.id}`}
                            className="block truncate font-bold text-ink hover:text-primary"
                          >
                            {row.title}
                          </Link>
                          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                            <span className="truncate">/{row.slug}</span>
                            <span>{row.language}</span>
                            <span>{formatDuration(row.durationSec)}</span>
                            {row.hasSub ? <span className="text-secondary">SUB</span> : null}
                            {row.hasDub ? <span className="text-accent">DUB</span> : null}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Pill value={row.deletedAt ? 'deleted' : row.status} />
                      {isScheduled(row) ? (
                        <span className="mt-1 block text-[11px] font-semibold text-secondary">
                          scheduled {formatDateTime(row.publishedAt)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      {row.job ? (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-ink-soft">
                            <Pill value={row.job.status} />
                            <span>{row.job.progress}%</span>
                          </div>
                          <Meter
                            percent={row.job.progress}
                            tone={row.job.status === 'dead' ? 'primary' : row.job.status === 'done' ? 'accent' : 'secondary'}
                          />
                          {row.job.status === 'dead' ? (
                            <Link href="/admin/queue" className="text-[11px] font-bold text-primary hover:underline">
                              failed after {row.job.attempts} attempts
                            </Link>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs font-bold text-ink-soft">{row.ageRating}</td>
                    <td className="px-3 py-3 text-right text-xs tabular-nums text-ink-soft">
                      {formatCount(row.viewCount)}
                    </td>
                    <td className="px-3 py-3 text-xs whitespace-nowrap text-muted">
                      {formatDateTime(row.updatedAt)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link href={`/admin/videos/${row.id}`} className={button.tiny}>
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result.pageCount > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-xs text-ink-soft">
            <span>
              Page {result.page} of {result.pageCount}
            </span>
            <span className="flex gap-2">
              {result.page > 1 ? (
                <Link href={href({ page: result.page - 1 })} className={button.tiny}>
                  Previous
                </Link>
              ) : null}
              {result.page < result.pageCount ? (
                <Link href={href({ page: result.page + 1 })} className={button.tiny}>
                  Next
                </Link>
              ) : null}
            </span>
          </div>
        ) : null}
      </Panel>
    </div>
  )
}

/** `ready` with a future publish time is what a scheduled title looks like. */
function isScheduled(row: { status: string; publishedAt: Date | null }): boolean {
  return row.status === 'ready' && row.publishedAt !== null && row.publishedAt.getTime() > Date.now()
}

function StatusChip({
  href,
  active,
  label,
  count,
}: {
  href: string
  active: boolean
  label: string
  count?: number
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
        active ? 'bg-ink text-white' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-mist'
      }`}
    >
      {label}
      {count === undefined ? null : <span className="ml-1.5 opacity-60">{count}</span>}
    </Link>
  )
}
