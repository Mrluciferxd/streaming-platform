'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { button, field, Label, Panel } from '../../ui'

export type EditorVideo = {
  id: string
  slug: string
  title: string
  description: string | null
  language: string
  ageRating: string
  contentDescriptor: string | null
  hasSub: boolean
  hasDub: boolean
  seasonLabel: string | null
  score: number | null
  /** Bucket-relative path, not a URL — see the note on the field below. */
  portraitPath: string | null
  portraitPreview: string | null
  status: string
  hasMedia: boolean
  deleted: boolean
  scheduledFor: string | null
  categoryIds: string[]
}

export type EditorSeriesLink = {
  episodeId: string
  seriesId: string
  seriesTitle: string
  seasonNo: number
  episodeNo: number
}

type SeriesOption = { id: string; title: string }
type Option = { value: string; label: string }

const ERRORS: Record<string, string> = {
  no_playable_media: 'There is no master playlist yet — the transcode has not finished.',
  scheduled_time_in_past: 'Pick a time in the future.',
  video_deleted: 'This title is soft-deleted. Restore it first.',
  restore_before_publishing: 'This title was taken down. Restore it first.',
  invalid_request: 'Some fields are not valid. Check the rating, score and portrait path.',
  not_found: 'Not found, or your session is no longer an operator session.',
  slot_taken: 'That season/episode slot is already used in this series.',
  already_attached: 'This video is already an episode of another series.',
}

export function VideoEditor({
  video,
  seriesLink,
  allSeries,
  categories,
  ratings,
}: {
  video: EditorVideo
  seriesLink: EditorSeriesLink | null
  allSeries: SeriesOption[]
  categories: { id: string; name: string }[]
  ratings: Option[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<string[]>(video.categoryIds)
  const [portrait, setPortrait] = useState(video.portraitPath ?? '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scheduleAt, setScheduleAt] = useState('')
  const [takedownReason, setTakedownReason] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Episode-picking state. Episode position defaults to the next slot after the
  // series' current last episode when one is selected, so the operator does not
  // have to look it up.
  const [attachSeriesId, setAttachSeriesId] = useState('')
  const [attachSeasonNo, setAttachSeasonNo] = useState('1')
  const [attachEpisodeNo, setAttachEpisodeNo] = useState('1')

  async function send(url: string, method: string, body: unknown) {
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
    const score = String(form.get('score') ?? '').trim()

    await send(`/api/admin/videos/${video.id}`, 'PATCH', {
      title: String(form.get('title') ?? '').trim(),
      description: String(form.get('description') ?? ''),
      language: String(form.get('language') ?? 'hi').trim(),
      ageRating: String(form.get('ageRating') ?? 'U'),
      contentDescriptor: String(form.get('contentDescriptor') ?? ''),
      categoryIds: selected,
      hasSub: form.get('hasSub') === 'on',
      hasDub: form.get('hasDub') === 'on',
      seasonLabel: String(form.get('seasonLabel') ?? ''),
      score: score === '' ? null : Number(score),
      portraitUrl: portrait.trim() || null,
    })
  }

  const status = (action: string, extra: Record<string, unknown> = {}) =>
    send(`/api/admin/videos/${video.id}/status`, 'POST', { action, ...extra })

  return (
    <div className="space-y-4">
      <Panel title="Metadata">
        <form
          className="grid gap-4 px-5 py-5 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            void saveMetadata(new FormData(event.currentTarget))
          }}
        >
          <label className="block sm:col-span-2">
            <Label hint={`/${video.slug}`}>Title</Label>
            <input name="title" defaultValue={video.title} required maxLength={200} className={field} />
          </label>

          <label className="block sm:col-span-2">
            <Label>Description</Label>
            <textarea
              name="description"
              defaultValue={video.description ?? ''}
              rows={4}
              className={`${field} resize-y`}
            />
          </label>

          <label className="block">
            <Label hint="ISO 639-1">Language</Label>
            <input name="language" defaultValue={video.language} maxLength={10} className={field} />
          </label>

          <label className="block">
            <Label hint="Fall 2026">Season label</Label>
            <input
              name="seasonLabel"
              defaultValue={video.seasonLabel ?? ''}
              maxLength={24}
              className={field}
            />
          </label>

          <label className="block">
            <Label hint="IT Rules 2021">Age rating</Label>
            <select name="ageRating" defaultValue={video.ageRating} className={field}>
              {ratings.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <Label hint="0–100, blank for none">Score</Label>
            <input
              name="score"
              type="number"
              min={0}
              max={100}
              defaultValue={video.score ?? ''}
              className={field}
            />
          </label>

          <label className="block sm:col-span-2">
            {/* The descriptor is not decoration: IT Rules requires the reason
                for the rating to be displayed with it. */}
            <Label hint="Shown next to the rating — required by IT Rules">Content descriptor</Label>
            <input
              name="contentDescriptor"
              defaultValue={video.contentDescriptor ?? ''}
              maxLength={500}
              placeholder="Violence, mild language"
              className={field}
            />
          </label>

          <div className="sm:col-span-2">
            <Label hint="Roughly 2:3, bucket path only">Portrait key visual</Label>
            <input
              value={portrait}
              onChange={(event) => setPortrait(event.target.value)}
              placeholder={`v/${video.id}/portrait.jpg`}
              className={field}
            />
            <p className="mt-1 text-xs text-muted">
              A path inside the media bucket, never a CDN URL — the provider resolves it at read
              time, which is what keeps a storage migration a config change.
            </p>
            {video.portraitPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={video.portraitPreview}
                alt=""
                className="mt-2 h-40 w-auto rounded-xl bg-mist object-cover ring-1 ring-line"
              />
            ) : null}
          </div>

          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-xs font-bold text-ink">Audio and subtitles</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  name="hasSub"
                  type="checkbox"
                  defaultChecked={video.hasSub}
                  className="h-4 w-4 accent-[#7c6bf0]"
                />
                Subtitled
              </label>
              <label className="flex items-center gap-2">
                <input
                  name="hasDub"
                  type="checkbox"
                  defaultChecked={video.hasDub}
                  className="h-4 w-4 accent-[#16b8a6]"
                />
                Dubbed
              </label>
            </div>
          </fieldset>

          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-xs font-bold text-ink">Categories</legend>
            {categories.length === 0 ? (
              <p className="text-xs text-muted">No categories exist yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {categories.map((category) => {
                  const on = selected.includes(category.id)
                  return (
                    <button
                      key={category.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setSelected((current) =>
                          on ? current.filter((id) => id !== category.id) : [...current, category.id],
                        )
                      }
                      className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                        on ? 'bg-primary text-white' : 'bg-mist text-ink-soft hover:bg-line'
                      }`}
                    >
                      {category.name}
                    </button>
                  )
                })}
              </div>
            )}
          </fieldset>

          <div className="flex items-center gap-3 sm:col-span-2">
            <button type="submit" className={button.primary} disabled={busy}>
              {busy ? 'Saving…' : 'Save metadata'}
            </button>
            {saved ? <span className="text-xs font-bold text-accent">Saved</span> : null}
          </div>
        </form>
      </Panel>

      <Panel
        title="Series placement"
        hint={
          seriesLink
            ? `Episode ${seriesLink.seasonNo}×${seriesLink.episodeNo} of ${seriesLink.seriesTitle}`
            : 'A standalone title — not part of any series'
        }
      >
        <div className="space-y-4 px-5 py-5">
          {seriesLink ? (
            <div className="space-y-3">
              <p className="rounded-xl bg-secondary-soft px-3.5 py-2.5 text-xs font-semibold text-secondary">
                Currently <strong>S{seriesLink.seasonNo}·E{seriesLink.episodeNo}</strong> of{' '}
                <Link
                  href={`/admin/series/${seriesLink.seriesId}`}
                  className="underline hover:no-underline"
                >
                  {seriesLink.seriesTitle}
                </Link>
                .
              </p>
              <button
                type="button"
                className={button.ghost}
                disabled={busy}
                onClick={async () => {
                  await send(`/api/admin/series/${seriesLink.seriesId}/episodes`, 'POST', {
                    action: 'detach',
                    episodeId: seriesLink.episodeId,
                  })
                }}
              >
                Detach from series
              </button>
              <p className="text-xs text-muted">
                Detaching leaves the video in the library — its media, watch history and revenue attribution
                all survive.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="block flex-1 basis-72">
                  <Label>Attach to series</Label>
                  <select
                    value={attachSeriesId}
                    onChange={(event) => setAttachSeriesId(event.target.value)}
                    className={field}
                  >
                    <option value="">— pick a series —</option>
                    {allSeries.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <Label>Season</Label>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={attachSeasonNo}
                    onChange={(event) => setAttachSeasonNo(event.target.value)}
                    className={`${field} w-20`}
                  />
                </label>
                <label className="block">
                  <Label>Episode</Label>
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={attachEpisodeNo}
                    onChange={(event) => setAttachEpisodeNo(event.target.value)}
                    className={`${field} w-24`}
                  />
                </label>
                <button
                  type="button"
                  className={button.primary}
                  disabled={busy || !attachSeriesId}
                  onClick={async () => {
                    const ok = await send(`/api/admin/series/${attachSeriesId}/episodes`, 'POST', {
                      action: 'attach',
                      videoId: video.id,
                      seasonNo: Number(attachSeasonNo),
                      episodeNo: Number(attachEpisodeNo),
                    })
                    if (ok) {
                      setAttachSeriesId('')
                      setAttachSeasonNo('1')
                      setAttachEpisodeNo('1')
                    }
                  }}
                >
                  Attach
                </button>
              </div>
              {allSeries.length === 0 ? (
                <p className="text-xs text-muted">
                  No series exist yet — create one on the{' '}
                  <Link href="/admin/series" className="hover:text-primary">
                    Series
                  </Link>{' '}
                  page.
                </p>
              ) : null}
            </div>
          )}

          {error ? (
            <p
              role="alert"
              className="rounded-xl bg-primary-soft px-3.5 py-2.5 text-xs font-semibold text-primary"
            >
              {error}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Publication"
        hint={
          video.deleted
            ? 'Soft-deleted. It is out of every public query.'
            : video.hasMedia
              ? `Currently ${video.status}`
              : 'No master playlist yet — publishing is blocked until the transcode finishes.'
        }
      >
        <div className="space-y-4 px-5 py-5">
          {video.scheduledFor ? (
            <p className="rounded-xl bg-secondary-soft px-3.5 py-2.5 text-xs font-semibold text-secondary">
              Scheduled to go live at {video.scheduledFor}. It publishes when the schedule sweep
              runs — from the library page, or on cron.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button.primary}
              disabled={busy || !video.hasMedia || video.deleted}
              onClick={() => void status('publish')}
            >
              Publish now
            </button>
            <button
              type="button"
              className={button.ghost}
              disabled={busy || video.status !== 'published'}
              onClick={() => void status('unpublish')}
            >
              Unpublish
            </button>
            {video.deleted || video.status === 'removed' ? (
              <button type="button" className={button.ghost} disabled={busy} onClick={() => void status('restore')}>
                Restore
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
            <label className="basis-60">
              <Label hint="Your local time">Schedule for</Label>
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(event) => setScheduleAt(event.target.value)}
                className={field}
              />
            </label>
            <button
              type="button"
              className={button.ghost}
              disabled={busy || !scheduleAt || !video.hasMedia}
              onClick={() => {
                const at = new Date(scheduleAt)
                if (Number.isNaN(at.getTime())) {
                  setError('That is not a valid date and time.')
                  return
                }
                void status('schedule', { at: at.toISOString() }).then((ok) => ok && setScheduleAt(''))
              }}
            >
              Schedule
            </button>
          </div>

          {error ? (
            <p role="alert" className="rounded-xl bg-primary-soft px-3.5 py-2.5 text-xs font-semibold text-primary">
              {error}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Takedown and deletion"
        hint="Both are recorded in the audit log with your name, the time and your IP."
      >
        <div className="space-y-4 px-5 py-5">
          <div>
            <Label hint="Required — this is the compliance record">Takedown reason</Label>
            <input
              value={takedownReason}
              onChange={(event) => setTakedownReason(event.target.value)}
              maxLength={500}
              placeholder="Court order ref, rights complaint, moderation decision"
              className={field}
            />
            <button
              type="button"
              className={`${button.danger} mt-2`}
              disabled={busy || takedownReason.trim().length < 3}
              onClick={() =>
                void status('takedown', { reason: takedownReason.trim() }).then(
                  (ok) => ok && setTakedownReason(''),
                )
              }
            >
              Take down
            </button>
            <p className="mt-1.5 text-xs text-muted">
              Removes it from every public surface immediately. The row, its history and its media
              stay, so the decision is reversible and the trail survives.
            </p>
          </div>

          <div className="border-t border-line pt-4">
            <button
              type="button"
              className={button.danger}
              disabled={busy || video.deleted}
              onClick={async () => {
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                await send(`/api/admin/videos/${video.id}`, 'DELETE', {})
                setConfirmDelete(false)
              }}
            >
              {confirmDelete ? 'Confirm delete' : 'Delete'}
            </button>
            <p className="mt-1.5 text-xs text-muted">
              A soft delete: the row keeps its watch history, revenue attribution and audit trail so
              a DPDP erasure does not take the record of the erasure with it.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  )
}
