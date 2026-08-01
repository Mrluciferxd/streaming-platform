import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { SeriesEditor } from './SeriesEditor'
import { requireAdminPage } from '@/lib/auth/require-role'
import {
  getAdminSeries,
  listAdminEpisodes,
  listAuditLog,
  listEpisodeCandidates,
  type AdminEpisodeRow,
} from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Edit series' }

export default async function AdminSeriesDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage()

  const { id } = await params
  // A malformed id would otherwise reach Postgres as an invalid uuid and throw.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()

  const seriesDetail = await getAdminSeries(id)
  if (!seriesDetail) notFound()

  const [episodes, candidates, audit] = await Promise.all([
    listAdminEpisodes(id),
    listEpisodeCandidates(id),
    listAuditLog(25, id),
  ])

  return (
    <SeriesEditor
      series={{
        id: seriesDetail.id,
        slug: seriesDetail.slug,
        title: seriesDetail.title,
        synopsis: seriesDetail.synopsis,
        status: seriesDetail.status,
        totalEpisodes: seriesDetail.totalEpisodes,
        studio: seriesDetail.studio,
        releaseYear: seriesDetail.releaseYear,
        seasonLabel: seriesDetail.seasonLabel,
        createdAt: seriesDetail.createdAt.toISOString(),
      }}
      episodes={episodes.map(toEpisode)}
      candidates={candidates.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        status: c.status,
        durationSec: c.durationSec,
        attachedSeriesId: c.attachedSeriesId,
        attachedSeriesTitle: c.attachedSeriesTitle,
      }))}
      audit={audit.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorName: entry.actorName ?? 'system',
        createdAt: entry.createdAt.toISOString(),
      }))}
    />
  )
}

function toEpisode(row: AdminEpisodeRow) {
  return {
    id: row.id,
    videoId: row.videoId,
    seasonNo: row.seasonNo,
    episodeNo: row.episodeNo,
    title: row.title,
    videoTitle: row.videoTitle,
    videoSlug: row.videoSlug,
    videoStatus: row.videoStatus,
  }
}
