import type { Metadata } from 'next'

import { SeriesManager } from './SeriesManager'
import { requireAdminPage } from '@/lib/auth/require-role'
import { listAdminSeries } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Series' }

export default async function AdminSeriesPage() {
  await requireAdminPage()

  const rows = await listAdminSeries()

  return (
    <SeriesManager
      initial={rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        totalEpisodes: row.totalEpisodes,
        releaseYear: row.releaseYear,
        seasonLabel: row.seasonLabel,
        studio: row.studio,
        episodeCount: row.episodeCount,
        updatedAt: row.updatedAt.toISOString(),
      }))}
    />
  )
}
