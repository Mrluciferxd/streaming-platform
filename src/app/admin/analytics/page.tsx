import type { Metadata } from 'next'
import Link from 'next/link'

import { Empty, Panel, Pill, Stat, button, field, formatCount, formatWatchTime } from '../ui'
import { requireAdminPage } from '@/lib/auth/require-role'
import { analyticsOverview, retentionCurve, type RetentionPoint } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Analytics' }

const WINDOWS = [7, 30, 90] as const

type Search = Record<string, string | string[] | undefined>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  await requireAdminPage()

  const params = await searchParams
  const requested = Number(first(params.days) ?? 30)
  const days = (WINDOWS as readonly number[]).includes(requested) ? requested : 30
  const videoId = first(params.video) && /^[0-9a-f-]{36}$/i.test(first(params.video)!) ? first(params.video)! : undefined

  const [overview, retention] = await Promise.all([
    analyticsOverview(days),
    retentionCurve(days, videoId),
  ])

  const { totals } = overview
  const focus = videoId ? overview.top.find((t) => t.videoId === videoId) : undefined

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {WINDOWS.map((window) => (
          <Link
            key={window}
            href={`/admin/analytics?days=${window}${videoId ? `&video=${videoId}` : ''}`}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
              days === window ? 'bg-ink text-white' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-mist'
            }`}
          >
            Last {window} days
          </Link>
        ))}
        <span className="text-xs text-muted">from {overview.since}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Views" value={formatCount(totals.views)} />
        <Stat
          label="Watch time"
          value={formatWatchTime(totals.watchSeconds)}
          sub={
            totals.views > 0
              ? `${formatWatchTime(totals.watchSeconds / totals.views)} per view`
              : undefined
          }
        />
        <Stat
          label="Completions"
          value={formatCount(totals.completions)}
          sub={totals.views > 0 ? `${percent(totals.completions / totals.views)} of views` : undefined}
        />
        <Stat
          label="Rebuffers"
          value={formatCount(totals.rebufferEvents)}
          // Plan §8 puts the rebuffer target under 0.5%. Per-view is the shape
          // an operator can act on; the ratio itself needs playback seconds the
          // rollup does not carry.
          sub={totals.views > 0 ? `${(totals.rebufferEvents / totals.views).toFixed(3)} per view` : undefined}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Views per day" hint="From the nightly rollup, not raw events">
          {overview.daily.length === 0 ? (
            <Empty>
              Nothing rolled up yet. `rollup_video_stats` runs nightly — until it does, a day of
              playback exists only as raw events.
            </Empty>
          ) : (
            <div className="px-5 py-4">
              <Bars
                points={overview.daily.map((d) => ({ label: d.day, value: d.views }))}
                format={formatCount}
              />
            </div>
          )}
        </Panel>

        <Panel title="Watch time per day">
          {overview.daily.length === 0 ? (
            <Empty>No watch time recorded in this window.</Empty>
          ) : (
            <div className="px-5 py-4">
              <Bars
                points={overview.daily.map((d) => ({ label: d.day, value: d.watchSeconds }))}
                format={formatWatchTime}
                tone="secondary"
              />
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Retention"
        hint={
          focus
            ? `${focus.title} — where viewers leave, in 5% steps`
            : 'All titles — where viewers leave, in 5% steps'
        }
        actions={
          overview.top.length > 0 ? (
            <form method="get" className="flex items-center gap-2">
              <input type="hidden" name="days" value={days} />
              <select name="video" defaultValue={videoId ?? ''} className={`${field} py-1.5 text-xs`} aria-label="Title">
                <option value="">All titles</option>
                {overview.top.map((title) => (
                  <option key={title.videoId} value={title.videoId}>
                    {title.title}
                  </option>
                ))}
              </select>
              <button type="submit" className={button.tiny}>
                Show
              </button>
            </form>
          ) : null
        }
      >
        {retention.every((point) => point.sessions === 0) ? (
          <Empty>No retention buckets recorded in this window.</Empty>
        ) : (
          <div className="px-5 py-4">
            <RetentionChart points={retention} />
            <p className="mt-2 text-xs text-muted">
              Normalised against the first bucket. A cliff between 0% and 5% is usually a broken
              first segment rather than a boring opening.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="Top titles" hint="By watch time, which is what advertisers pay against">
        {overview.top.length === 0 ? (
          <Empty>No title has any recorded watch time in this window.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                  <th className="px-5 py-2.5">Title</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Watch time</th>
                  <th className="px-3 py-2.5 text-right">Views</th>
                  <th className="px-5 py-2.5 text-right">Completion</th>
                </tr>
              </thead>
              <tbody>
                {overview.top.map((title) => (
                  <tr key={title.videoId} className="border-b border-line/70 last:border-0">
                    <td className="px-5 py-2.5">
                      <Link href={`/admin/videos/${title.videoId}`} className="font-bold text-ink hover:text-primary">
                        {title.title}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <Pill value={title.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-soft">
                      {formatWatchTime(title.watchSeconds)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-soft">
                      {formatCount(title.views)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-ink-soft">
                      {title.views > 0 ? percent(title.completions / title.views) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

/**
 * Charts are inline SVG rather than a charting library.
 *
 * Two bar charts and a line do not justify 60 kB of JavaScript on a page whose
 * whole job is to render numbers the server already has, and these render
 * before any script loads.
 */
function Bars({
  points,
  format,
  tone = 'primary',
}: {
  points: { label: string; value: number }[]
  format: (value: number) => string
  tone?: 'primary' | 'secondary'
}) {
  const width = 600
  const height = 140
  const max = Math.max(...points.map((p) => p.value), 1)
  const slot = width / points.length
  const barWidth = Math.max(1, Math.min(slot - 2, 26))

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Daily totals">
        {points.map((point, index) => {
          const barHeight = Math.max(1, (point.value / max) * (height - 18))
          return (
            <rect
              key={point.label}
              x={index * slot + (slot - barWidth) / 2}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx={3}
              className={tone === 'secondary' ? 'fill-secondary' : 'fill-primary'}
            >
              <title>{`${point.label}: ${format(point.value)}`}</title>
            </rect>
          )
        })}
      </svg>
      <figcaption className="mt-1.5 flex justify-between text-[11px] text-muted">
        <span>{points[0]?.label}</span>
        <span className="font-bold text-ink-soft">peak {format(max)}</span>
        <span>{points.at(-1)?.label}</span>
      </figcaption>
    </figure>
  )
}

function RetentionChart({ points }: { points: RetentionPoint[] }) {
  const width = 600
  const height = 180
  const padding = 6

  const x = (bucket: number) => padding + (bucket / 20) * (width - padding * 2)
  const y = (value: number) => height - padding - (value / 100) * (height - padding * 2)

  const line = points.map((p) => `${x(p.bucket).toFixed(1)},${y(p.percent).toFixed(1)}`).join(' ')
  const area = `${x(0)},${height - padding} ${line} ${x(20)},${height - padding}`

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Retention curve">
        {[25, 50, 75].map((gridline) => (
          <line
            key={gridline}
            x1={padding}
            x2={width - padding}
            y1={y(gridline)}
            y2={y(gridline)}
            className="stroke-line"
            strokeWidth={1}
          />
        ))}

        <polygon points={area} className="fill-primary" opacity={0.12} />
        <polyline points={line} fill="none" className="stroke-primary" strokeWidth={2.5} strokeLinejoin="round" />

        {points.map((point) => (
          <circle key={point.bucket} cx={x(point.bucket)} cy={y(point.percent)} r={3} className="fill-primary">
            <title>{`${point.bucket * 5}% in — ${point.percent.toFixed(0)}% of viewers (${formatCount(point.sessions)} sessions)`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="mt-1.5 flex justify-between text-[11px] text-muted">
        <span>start</span>
        <span>halfway</span>
        <span>end</span>
      </figcaption>
    </figure>
  )
}
