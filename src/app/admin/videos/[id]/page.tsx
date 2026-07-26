import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { VideoEditor } from './VideoEditor'
import { Empty, Meter, Panel, Pill, formatBytes, formatCount, formatDateTime, formatDuration } from '../../ui'
import { requireAdminPage } from '@/lib/auth/require-role'
import {
  AGE_RATING_LABELS,
  AGE_RATINGS,
  getAdminVideo,
  listAdminCategories,
  listAuditLog,
} from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Edit title' }

export default async function AdminVideoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage()

  const { id } = await params
  // A malformed id would otherwise reach Postgres as an invalid uuid and throw.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()

  const video = await getAdminVideo(id)
  if (!video) notFound()

  const [categories, audit] = await Promise.all([listAdminCategories(), listAuditLog(25, id)])

  const scheduled =
    video.status === 'ready' && video.publishedAt && video.publishedAt.getTime() > Date.now()
      ? formatDateTime(video.publishedAt)
      : null

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin" className="text-xs font-bold text-muted hover:text-primary">
            ← Library
          </Link>
          <Pill value={video.deletedAt ? 'deleted' : video.status} />
          {video.status === 'published' ? (
            <Link
              href={`/watch/${video.slug}`}
              className="text-xs font-bold text-secondary hover:underline"
              target="_blank"
            >
              View on the site ↗
            </Link>
          ) : null}
        </div>

        <VideoEditor
          video={{
            id: video.id,
            slug: video.slug,
            title: video.title,
            description: video.description,
            language: video.language,
            ageRating: video.ageRating,
            contentDescriptor: video.contentDescriptor,
            hasSub: video.hasSub,
            hasDub: video.hasDub,
            seasonLabel: video.seasonLabel,
            score: video.score,
            portraitPath: video.portraitUrl,
            portraitPreview: video.previews.portrait,
            status: video.status,
            hasMedia: video.hlsMasterPath !== null,
            deleted: video.deletedAt !== null,
            scheduledFor: scheduled,
            categoryIds: video.categoryIds,
          }}
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          ratings={AGE_RATINGS.map((value) => ({ value, label: AGE_RATING_LABELS[value] }))}
        />
      </div>

      <aside className="space-y-4">
        <Panel title="Pipeline">
          <dl className="space-y-2.5 px-5 py-4 text-xs">
            <Row label="Provider" value={video.provider} />
            <Row label="Runtime" value={formatDuration(video.durationSec)} />
            <Row label="Source" value={formatBytes(video.sourceSizeBytes)} />
            <Row label="Master" value={video.hlsMasterPath ?? 'not packaged'} mono />
            <Row label="Uploader" value={video.uploader?.displayName ?? '—'} />
            <Row label="Views" value={formatCount(video.viewCount)} />
            <Row label="Published" value={formatDateTime(video.publishedAt)} />
            <Row label="Created" value={formatDateTime(video.createdAt)} />
          </dl>

          {video.job ? (
            <div className="space-y-1.5 border-t border-line px-5 py-4">
              <div className="flex items-center justify-between text-xs font-bold text-ink-soft">
                <span className="flex items-center gap-2">
                  Transcode <Pill value={video.job.status} />
                </span>
                <span>{video.job.progress}%</span>
              </div>
              <Meter
                percent={video.job.progress}
                tone={video.job.status === 'dead' ? 'primary' : video.job.status === 'done' ? 'accent' : 'secondary'}
              />
              {video.job.lastError ? (
                <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-mist p-2 text-[11px] whitespace-pre-wrap text-primary">
                  {video.job.lastError}
                </pre>
              ) : null}
            </div>
          ) : null}
        </Panel>

        <Panel title="Renditions" hint={`${video.variants.length} in the ladder`}>
          {video.variants.length === 0 ? (
            <Empty>Nothing encoded yet.</Empty>
          ) : (
            <ul className="divide-y divide-line text-xs">
              {video.variants.map((variant) => (
                <li key={variant.id} className="flex items-center justify-between px-5 py-2.5">
                  <span className="font-bold text-ink">{variant.resolution}</span>
                  <span className="text-muted">
                    {variant.width}×{variant.height} · {variant.bitrateKbps}k
                    {/* Peak, not average: the master playlist's BANDWIDTH is
                        built from this and hls.js picks renditions by it. */}
                    <span className="text-ink-soft"> (peak {variant.peakBitrateKbps}k)</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Audit trail" hint="Every privileged action on this title">
          {audit.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <ul className="divide-y divide-line text-xs">
              {audit.map((entry) => (
                <li key={entry.id} className="px-5 py-2.5">
                  <p className="font-bold text-ink">{entry.action}</p>
                  <p className="text-muted">
                    {entry.actorName ?? 'system'} · {formatDateTime(entry.createdAt)}
                  </p>
                  {reasonOf(entry.after) ? (
                    <p className="mt-1 text-ink-soft">“{reasonOf(entry.after)}”</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </aside>
    </div>
  )
}

function reasonOf(after: unknown): string | null {
  if (after && typeof after === 'object' && 'reason' in after) {
    const reason = (after as { reason?: unknown }).reason
    return typeof reason === 'string' ? reason : null
  }
  return null
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={`min-w-0 truncate text-right font-semibold text-ink-soft ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
