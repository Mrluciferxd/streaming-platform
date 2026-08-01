'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { button, Empty, field, Label, Panel, Pill, formatDateTime } from '../ui'

export type SeriesRow = {
  id: string
  slug: string
  title: string
  status: string
  totalEpisodes: number | null
  releaseYear: number | null
  seasonLabel: string | null
  studio: string | null
  episodeCount: number
  updatedAt: string
}

const ERRORS: Record<string, string> = {
  slug_taken: 'Another series already uses that slug.',
  slug_empty: 'That title produces an empty slug — give it an explicit one.',
  invalid_request: 'Check the title, slug, and episode count.',
}

/**
 * Series list and the new-series form.
 *
 * Mirrors the categories screen on purpose: same left-list / right-create
 * split, same optimistic-refresh pattern, same audit-on-the-server contract.
 * Operators who learned one screen already know the other.
 */
export function SeriesManager({ initial }: { initial: SeriesRow[] }) {
  const router = useRouter()
  const [items, setItems] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setItems(initial), [initial])

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true)
    setError(null)

    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        setError(ERRORS[data.error ?? ''] ?? `Request failed (${response.status}).`)
        return false
      }

      router.refresh()
      return true
    } catch {
      setError('Could not reach the server.')
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Panel
        title="Series"
        hint="A series is public as soon as one of its episodes is — there is no separate publish flag"
      >
        {error ? (
          <p
            role="alert"
            className="mx-5 mt-4 rounded-xl bg-primary-soft px-3.5 py-2.5 text-xs font-semibold text-primary"
          >
            {error}
          </p>
        ) : null}

        {items.length === 0 ? (
          <Empty>No series yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                  <th className="px-5 py-2.5">Title</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Episodes</th>
                  <th className="px-3 py-2.5">Season</th>
                  <th className="px-3 py-2.5">Studio</th>
                  <th className="px-3 py-2.5">Updated</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-b border-line/70 last:border-0 hover:bg-mist/60">
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/series/${row.id}`}
                        className="block truncate font-bold text-ink hover:text-primary"
                      >
                        {row.title}
                      </Link>
                      <span className="mt-0.5 block truncate text-xs text-muted">/series/{row.slug}</span>
                    </td>
                    <td className="px-3 py-3">
                      <Pill value={row.status} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-ink-soft">
                      {row.episodeCount}
                      {row.totalEpisodes ? (
                        <span className="text-muted"> / {row.totalEpisodes}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted">
                      {row.seasonLabel ?? (row.releaseYear ?? '—')}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted">{row.studio ?? '—'}</td>
                    <td className="px-3 py-3 text-xs whitespace-nowrap text-muted">
                      {formatDateTime(row.updatedAt)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link href={`/admin/series/${row.id}`} className={button.tiny}>
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="New series">
        <form
          className="space-y-3 px-5 py-5"
          onSubmit={async (event) => {
            event.preventDefault()
            const element = event.currentTarget
            const form = new FormData(element)
            const totalEpisodesRaw = String(form.get('totalEpisodes') ?? '').trim()
            const releaseYearRaw = String(form.get('releaseYear') ?? '').trim()

            const ok = await call('/api/admin/series', 'POST', {
              title: String(form.get('title') ?? ''),
              slug: String(form.get('slug') ?? '') || undefined,
              synopsis: String(form.get('synopsis') ?? ''),
              status: String(form.get('status') ?? 'airing'),
              totalEpisodes: totalEpisodesRaw === '' ? null : Number(totalEpisodesRaw),
              studio: String(form.get('studio') ?? ''),
              releaseYear: releaseYearRaw === '' ? null : Number(releaseYearRaw),
              seasonLabel: String(form.get('seasonLabel') ?? ''),
            })
            if (ok) element.reset()
          }}
        >
          <label className="block">
            <Label>Title</Label>
            <input name="title" required maxLength={200} placeholder="Sakura Chronicles" className={field} />
          </label>
          <label className="block">
            <Label hint="Optional, derived from the title">Slug</Label>
            <input name="slug" maxLength={160} placeholder="leave blank to derive" className={field} />
          </label>
          <label className="block">
            <Label hint="Optional">Synopsis</Label>
            <textarea name="synopsis" rows={3} maxLength={20_000} className={`${field} resize-y`} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <Label>Status</Label>
              <select name="status" defaultValue="airing" className={field}>
                <option value="announced">announced</option>
                <option value="airing">airing</option>
                <option value="hiatus">hiatus</option>
                <option value="completed">completed</option>
                <option value="cancelled">cancelled</option>
              </select>
            </label>
            <label className="block">
              <Label hint="Optional">Total episodes</Label>
              <input name="totalEpisodes" type="number" min={1} max={9999} placeholder="24" className={field} />
            </label>
            <label className="block">
              <Label hint="Optional, e.g. Fall 2026">Season label</Label>
              <input name="seasonLabel" maxLength={24} className={field} />
            </label>
            <label className="block">
              <Label hint="Optional">Release year</Label>
              <input name="releaseYear" type="number" min={1900} max={2200} className={field} />
            </label>
          </div>
          <label className="block">
            <Label hint="Optional">Studio</Label>
            <input name="studio" maxLength={120} placeholder="Studio Ghibli" className={field} />
          </label>
          <button type="submit" className={button.primary} disabled={busy}>
            {busy ? 'Creating…' : 'Create series'}
          </button>
        </form>
      </Panel>
    </div>
  )
}
