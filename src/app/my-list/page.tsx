import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { and, desc, eq } from 'drizzle-orm'

import { TitleGrid } from '@/components/Row'
import { db, videos, watchlist } from '@/db'
import { getSessionUser } from '@/lib/auth/session'
import type { VideoCard } from '@/lib/queries/videos'
import { getVideoProvider } from '@/lib/video'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'My List',
  // Per-viewer content; nothing here should ever be indexed.
  robots: { index: false, follow: false },
}

export default async function MyListPage() {
  const user = await getSessionUser()
  if (!user) redirect('/account?next=%2Fmy-list')

  const rows = await db
    .select({
      id: videos.id,
      slug: videos.slug,
      title: videos.title,
      durationSec: videos.durationSec,
      posterUrl: videos.posterUrl,
      portraitUrl: videos.portraitUrl,
      previewUrl: videos.previewUrl,
      language: videos.language,
      ageRating: videos.ageRating,
      hasSub: videos.hasSub,
      hasDub: videos.hasDub,
      seasonLabel: videos.seasonLabel,
      score: videos.score,
      viewCount: videos.viewCount,
      publishedAt: videos.publishedAt,
    })
    .from(watchlist)
    .innerJoin(videos, eq(videos.id, watchlist.videoId))
    .where(and(eq(watchlist.userId, user.id), eq(videos.status, 'published')))
    .orderBy(desc(watchlist.addedAt))
    .limit(200)

  const provider = await getVideoProvider()
  const items: VideoCard[] = rows.map((row) => ({
    ...row,
    posterUrl: row.posterUrl ? provider.publicUrl(row.posterUrl) : null,
    portraitUrl: row.portraitUrl ? provider.publicUrl(row.portraitUrl) : null,
    previewUrl: row.previewUrl ? provider.publicUrl(row.previewUrl) : null,
  }))

  return (
    <div className="px-4 pt-28 pb-16 sm:px-12">
      <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">My List</h1>

      <div className="mt-6">
        {items.length > 0 ? (
          <TitleGrid videos={items} />
        ) : (
          <div className="py-16 text-center">
            <p className="text-sm text-ink-soft">Nothing saved yet.</p>
            <Link
              href="/"
              className="mt-4 inline-block rounded-full bg-primary px-6 py-2.5 text-sm font-bold text-white shadow-lg shadow-primary/30 transition hover:-translate-y-0.5"
            >
              Browse the catalogue
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
