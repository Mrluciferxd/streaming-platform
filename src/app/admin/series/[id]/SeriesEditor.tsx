'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { button, Empty, field, Label, Panel, Pill, formatDateTime } from '../../ui'

export type SeriesDetail = {
  id: string
  slug: string
  title: string
  synopsis: string | null
  status: string
  totalEpisodes: number | null
  studio: string | null
  releaseYear: number | null
  seasonLabel: string | null
  createdAt: string
}

export type EpisodeRow = {
  id: string
  videoId: string
  seasonNo: number
  episodeNo: number
  title: string | null
  videoTitle: string
  videoSlug: string
  videoStatus: string
}

export type EpisodeCandidate = {
  id: string
  slug: string
  title: string
  status: string
  durationSec: number | null
  attachedSeriesId: string | null
  attachedSeriesTitle: string | null
}

type AuditRow = {
  id: number
  action: string
  actorName: string
  createdAt: string
}

const ERRORS: Record<string, string> = {
  slug_taken: 'Another series already uses that slug.',
  slug_empty: 'A slug derived from that title is empty — give it an explicit one.',
  invalid_request: 'Some fields are not valid.',
  not_found: 'This series is gone, or your session is no longer an operator session.',
  slot_taken: 'That season/episode slot is already used in this series.',
  already_attached: 'That video is already an episode of another series.',
}

/**
 * Series editor.
 *
 * Two concerns stay separate on purpose: the series *metadata* form (top) and
 * the *episode list* (below). Editing the title does not touch the episodes;
 * moving an episode does not touch the title. An accidental publish-keypress
 * pattern (see the status route comment) is a separate choice from mistakenly
 * reordering a 24-episode cour.
 */
export function SeriesEditor({
  series,
  episodes: initialEpisodes,
  candidates: initialCandidates,
  audit,
}: {
  series: SeriesDetail
  episodes: EpisodeRow[]
  candidates: EpisodeCandidate[]
  audit: AuditRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [episodes, setEpisodes] = useState(initialEpisodes)
  const [candidates, setCandidates] = useState(initialCandidates)
  const [candidateQuery, setCandidateQuery] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState('')
  const [newSeasonNo, setNewSeasonNo] = useState('1')
  const [newEpisodeNo, setNewEpisodeNo] = useState('1')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true)
    setError(null)
    setSaved(false)

    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        setError(ERRORS[data.error ?? ''] ?? `Request failed (${response.status}).`)
        return false
      }

      setSaved(true)
      router.refresh()
      return true
    } catch {
      setError('Could not reach the server.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveMetadata(form: FormData) {
    const synopsis = String(form.get('synopsis') ?? '').trim()
    const totalEpisodesRaw = String(form.get('totalEpisodes') ?? '').trim()
    const releaseYearRaw = String(form.get('releaseYear') ?? '').trim()

    await call(`/api/admin/series/${series.id}`, 'PATCH', {
      title: String(form.get('title') ?? '').trim(),
      slug: String(form.get('slug') ?? '').trim(),
      synopsis: synopsis === '' ? null : synopsis,
      status: String(form.get('status') ?? 'airing'),
      totalEpisodes: totalEpisodesRaw === '' ? null : Number(totalEpisodesRaw),
      studio: String(form.get('studio') ?? '').trim() || null,
      releaseYear: releaseYearRaw === '' ? null : Number(releaseYearRaw),
      seasonLabel: String(form.get('seasonLabel') ?? '').trim() || null,
    })
  }

  async function moveEpisode(index: number, direction: -1 | 1) {
    // Reordering works in (season, episode) tuples, so "down" means the next
    // episode in broadcast order — same season +1, or the first episode of the
    // next season if this was the last of its season. To keep the operation
    // legible, this swaps the episode *numbers* of two adjacent rows rather
    // than reshuffling the whole list: a 26-episode list does one update, not
    // twenty-six.
    const target = index + direction
    if (target < 0 || target >= episodes.length) return

    const next = [...episodes]
    const a = next[index]
    const b = next[target]
    if (!a || !b) return

    // Swap episode numbers; keep seasons. The episodes_series_season_ep_key
    // unique index forbids duplicates, so update the higher-numbered one first
    // to hold the (season, next_ep+delta) slot, then drop the lower to the
    // previously free slot. Easier: drop both to a free range, then set the
    // new values. Simplest given only two rows updates each in one statement
    // using a transient offset (+10000 lands well outside any real episodeNo):
    next.splice(index, 2, { ...a, episodeNo: b.episodeNo }, { ...b, episodeNo: a.episodeNo })
    setEpisodes(next)

    await call(`/api/admin/series/${series.id}/episodes`, 'POST', {
      action: 'update',
      episodeId: a.id,
      episodeNo: b.episodeNo,
    })
    await call(`/api/admin/series/${series.id}/episodes`, 'POST', {
      action: 'update',
      episodeId: b.id,
      episodeNo: a.episodeNo,
    })
  }

  async function addEpisode() {
    if (!selectedCandidate) return
    const ok = await call(`/api/admin/series/${series.id}/episodes`, 'POST', {
      action: 'attach',
      videoId: selectedCandidate,
      seasonNo: Number(newSeasonNo),
      episodeNo: Number(newEpisodeNo),
    })
    if (ok) {
      setSelectedCandidate('')
      setCandidates((cur) => cur.filter((c) => c.id !== selectedCandidate))
    }
  }

  async function removeEpisode(episodeId: string) {
    await call(`/api/admin/series/${series.id}/episodes`, 'POST', {
      action: 'detach',
      episodeId,
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin/series" className="text-xs font-bold text-muted hover:text-primary">
            ← Series
          </Link>
          <Pill value={series.status} />
        </div>

        {/* Metadata — slug change re-points the public /series/<slug> URL. */}
        <Panel title="Series metadata" hint="Episode ordering does not touch the row below.">
          <form
            className="grid gap-4 px-5 py-5 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              void saveMetadata(new FormData(event.currentTarget))
            }}
          >
            <label className="block sm:col-span-2">
              <Label hint={`/${series.slug}`}>Title</Label>
              <input name="title" defaultValue={series.title} required maxLength={200} className={field} />
            </label>

            <label className="block sm:col-span-2">
              <Label>Description</Label>
              <textarea
                name="synopsis"
                defaultValue={series.synopsis ?? ''}
                rows={4}
                maxLength={20_000}
                className={`${field} resize-y`}
              />
            </label>

            <label className="block">
              <Label hint="URL path">Slug</Label>
              <input name="slug" defaultValue={series.slug} required maxLength={160} className={field} />
            </label>

            <label className="block">
              <Label>Status</Label>
              <select name="status" defaultValue={series.status} className={field}>
                <option value="announced">announced</option>
                <option value="airing">airing</option>
                <option value="hiatus">hiatus</option>
                <option value="completed">completed</option>
                <option value="cancelled">cancelled</option>
              </select>
            </label>

            <label className="block">
              <Label hint="Optional">Total episodes announced</Label>
              <input
                name="totalEpisodes"
                type="number"
                min={1}
                max={9999}
                defaultValue={series.totalEpisodes ?? ''}
                className={field}
              />
            </label>

            <label className="block">
              <Label hint="e.g. Fall 2026">Season label</Label>
              <input name="seasonLabel" defaultValue={series.seasonLabel ?? ''} maxLength={24} className={field} />
            </label>

            <label className="block">
              <Label hint="Optional">Studio</Label>
              <input name="studio" defaultValue={series.studio ?? ''} maxLength={120} className={field} />
            </label>

            <label className="block">
              <Label hint="Optional">Release year</Label>
              <input
                name="releaseYear"
                type="number"
                min={1900}
                max={2200}
                defaultValue={series.releaseYear ?? ''}
                className={field}
              />
            </label>

            <div className="flex items-center gap-3 sm:col-span-2">
              <button type="submit" className={button.primary} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              {saved ? <span className="text-xs font-bold text-accent">Saved</span> : null}
            </div>
          </form>
        </Panel>

        {/* Episode list + add-episode picker. Separate panel from metadata. */}
        <Panel title="Episodes" hint={`${episodes.length} in this series`}>
          {error ? (
            <p
              role="alert"
              className="mx-5 mt-4 rounded-xl bg-primary-soft px-3.5 py-2.5 text-xs font-semibold text-primary"
            >
              {error}
            </p>
          ) : null}

          {episodes.length === 0 ? (
            <Empty>No episodes attached yet. Pick one below.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {episodes.map((episode, index) => (
                <li key={episode.id} className="px-5 py-3">
                  {editingId === episode.id ? (
                    <form
                      className="space-y-2"
                      onSubmit={async (event) => {
                        event.preventDefault()
                        const form = new FormData(event.currentTarget)
                        const ok = await call(`/api/admin/series/${series.id}/episodes`, 'POST', {
                          action: 'update',
                          episodeId: episode.id,
                          seasonNo: Number(form.get('seasonNo') ?? episode.seasonNo),
                          episodeNo: Number(form.get('episodeNo') ?? episode.episodeNo),
                          title: String(form.get('title') ?? '') || null,
                        })
                        if (ok) setEditingId(null)
                      }}
                    >
                      <div className="flex flex-wrap gap-2">
                        <input
                          name="seasonNo"
                          type="number"
                          min={1}
                          max={99}
                          defaultValue={episode.seasonNo}
                          className={`${field} w-20`}
                        />
                        <input
                          name="episodeNo"
                          type="number"
                          min={1}
                          max={9999}
                          defaultValue={episode.episodeNo}
                          className={`${field} w-24`}
                        />
                        <input
                          name="title"
                          defaultValue={episode.title ?? ''}
                          maxLength={200}
                          placeholder={episode.videoTitle}
                          className={`${field} flex-1`}
                        />
                        <button type="submit" className={button.primary} disabled={busy}>
                          Save
                        </button>
                        <button type="button" className={button.ghost} onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          aria-label="Move up"
                          disabled={busy || index === 0}
                          onClick={() => void moveEpisode(index, -1)}
                          className="rounded px-1.5 text-xs font-bold text-muted hover:text-primary disabled:opacity-25"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          aria-label="Move down"
                          disabled={busy || index === episodes.length - 1}
                          onClick={() => void moveEpisode(index, 1)}
                          className="rounded px-1.5 text-xs font-bold text-muted hover:text-primary disabled:opacity-25"
                        >
                          ▼
                        </button>
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-ink">
                          <span className="text-muted">S{episode.seasonNo}·E{episode.episodeNo}</span>{' '}
                          {episode.title ?? episode.videoTitle}
                        </p>
                        <p className="truncate text-xs text-muted">
                          <Link href={`/admin/videos/${episode.videoId}`} className="hover:text-primary">
                            {episode.videoSlug}
                          </Link>{' '}
                          · <Pill value={episode.videoStatus} muted />
                        </p>
                      </div>

                      <div className="flex shrink-0 gap-2">
                        <button type="button" className={button.tiny} onClick={() => setEditingId(episode.id)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className={button.tiny}
                          disabled={busy}
                          onClick={() => void removeEpisode(episode.id)}
                        >
                          Detach
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Add-episode picker below the list. Sits in the same panel: the
              relationship between "episodes" and "candidates" is the
              strongest grouping among them, and a separate panel would force
              the operator's eye across the page. */}
          <div className="space-y-3 border-t border-line px-5 py-4">
            <h3 className="text-xs font-bold tracking-wide text-muted uppercase">Attach an existing video</h3>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block flex-1 basis-72">
                <Label hint="Pick a video from the library">Video</Label>
                <input
                  type="text"
                  value={candidateQuery}
                  onChange={(event) => setCandidateQuery(event.target.value)}
                  placeholder="Filter titles…"
                  className={field}
                />
              </label>
              <label className="block">
                <Label>Season</Label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={newSeasonNo}
                  onChange={(event) => setNewSeasonNo(event.target.value)}
                  className={`${field} w-20`}
                />
              </label>
              <label className="block">
                <Label>Episode</Label>
                <input
                  type="number"
                  min={1}
                  max={9999}
                  value={newEpisodeNo}
                  onChange={(event) => setNewEpisodeNo(event.target.value)}
                  className={`${field} w-24`}
                />
              </label>
              <button
                type="button"
                className={button.primary}
                disabled={busy || !selectedCandidate}
                onClick={() => void addEpisode()}
              >
                Attach
              </button>
            </div>

            {/* Render the filtered candidates as a small scrollable list.
                A native <select> would be simpler but cannot show the
                "already on X" hint, which is exactly the row that needs to
                explain itself rather than just disappear from the picker. */}
            <div className="max-h-56 overflow-auto rounded-xl bg-mist/60 p-1">
              {candidates
                .filter((c) =>
                  candidateQuery.trim() === ''
                    ? true
                    : c.title.toLowerCase().includes(candidateQuery.trim().toLowerCase()),
                )
                .map((candidate) => {
                  const onThis = candidate.attachedSeriesId === series.id
                  const onOther = candidate.attachedSeriesId && candidate.attachedSeriesId !== series.id
                  const disabled = !onOther
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      disabled={!!disabled}
                      onClick={() => setSelectedCandidate(candidate.id)}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                        selectedCandidate === candidate.id
                          ? 'bg-primary text-white'
                          : onOther
                            ? 'bg-surface/40 text-muted'
                            : 'bg-surface hover:bg-white/80'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-bold">{candidate.title}</span>
                        <span className="block truncate text-xs opacity-70">
                          {onOther ? `Already on ${candidate.attachedSeriesTitle}` : `/watch/${candidate.slug}`}
                        </span>
                      </span>
                      <Pill value={candidate.status} muted />
                    </button>
                  )
                })}
            </div>
            <p className="text-xs text-muted">
              A video belongs to at most one series, so a title already on another series is greyed out.
            </p>
          </div>
        </Panel>
      </div>

      <aside className="space-y-4">
        <Panel title="Series details">
          <dl className="space-y-2.5 px-5 py-4 text-xs">
            <Row label="Created" value={formatDateTime(series.createdAt)} />
            <Row label="Status" value={series.status} />
            <Row label="Announced total" value={series.totalEpisodes === null ? '—' : String(series.totalEpisodes)} />
            <Row label="Studio" value={series.studio ?? '—'} />
            <Row label="Season label" value={series.seasonLabel ?? '—'} />
          </dl>
        </Panel>

        <Panel title="Audit trail" hint="The most recent privileged actions on this series">
          {audit.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <ul className="divide-y divide-line text-xs">
              {audit.map((entry) => (
                <li key={entry.id} className="px-5 py-2.5">
                  <p className="font-bold text-ink">{entry.action}</p>
                  <p className="text-muted">
                    {entry.actorName} · {formatDateTime(entry.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Delete series">
          <div className="space-y-3 px-5 py-5">
            <button
              type="button"
              className={button.danger}
              disabled={busy}
              onClick={async () => {
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                await call(`/api/admin/series/${series.id}`, 'DELETE', {})
                setConfirmDelete(false)
              }}
            >
              {confirmDelete ? 'Confirm delete' : 'Delete series'}
            </button>
            <p className="text-xs text-muted">
              Cascade-removes the episodes join rows. The videos rows and all their media, watch history and
              revenue attribution survive — a series going away is reversible by reattaching the same videos.
            </p>
          </div>
        </Panel>
      </aside>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-semibold text-ink-soft">{value}</dd>
    </div>
  )
}
