import Link from 'next/link'

import { and, eq } from 'drizzle-orm'

import { Hero } from '@/components/Hero'
import { Row } from '@/components/Row'
import { db, watchlist } from '@/db'
import { getSessionUser } from '@/lib/auth/session'
import {
  getVideoBySlug,
  listByCategory,
  listCategoriesWithVideos,
  listLatest,
  listTrending,
} from '@/lib/queries/videos'

/**
 * Home.
 *
 * A billboard, then rows. ISR with a 60s window, because the catalogue changes
 * when something is published rather than per request — so almost every visitor
 * gets a static page and TTFB stays under the plan §8 target without a cache in
 * front of the database.
 *
 * Continue Watching is absent on purpose: it is per-viewer, and putting it on a
 * shared cached page would either leak one viewer's history to the next or make
 * the page uncacheable.
 */
/**
 * Rendered per request rather than ISR-cached.
 *
 * The billboard now reflects whether *this* viewer has the featured title in
 * their list, which is per-person state. A shared cached page would show one
 * viewer's list status to everyone. The rows themselves are still cheap — the
 * queries behind them are all index scans — and Redis caching of the shared
 * parts (plan §8) is the right next step, not caching the whole page.
 */
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Watch anime free — subbed and dubbed',
  description:
    'Stream anime series and films free. Simulcast seasons, subs and dubs, no subscription.',
}

export default async function Home() {
  const [trending, latest, categories] = await Promise.all([
    listTrending(12),
    listLatest(12),
    listCategoriesWithVideos(5),
  ])

  if (latest.items.length === 0) return <EmptyLibrary />

  // The billboard leads on whatever is trending, falling back to newest.
  const featured = trending[0] ?? latest.items[0]!
  const [featuredDetail, user] = await Promise.all([
    getVideoBySlug(featured.slug),
    getSessionUser(),
  ])

  const inList = user
    ? (
        await db
          .select({ videoId: watchlist.videoId })
          .from(watchlist)
          .where(and(eq(watchlist.userId, user.id), eq(watchlist.videoId, featured.id)))
          .limit(1)
      ).length > 0
    : false

  const categoryRows = await Promise.all(
    categories.map(async (category) => ({
      ...category,
      videos: (await listByCategory(category.slug, 12)).items,
    })),
  )

  return (
    <>
      <Hero
        video={featured}
        description={featuredDetail?.description}
        signedIn={Boolean(user)}
        inList={inList}
      />

      <div className="relative z-10 pb-12">
        <Row title="Top 10 This Week" videos={trending} ranked priority />
        <Row title="New Episodes" videos={latest.items} />

        {categoryRows.map((category) => (
          <Row key={category.id} title={category.name} videos={category.videos} />
        ))}
      </div>
    </>
  )
}

function EmptyLibrary() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">
        Nothing published yet
      </h1>
      <p className="text-sm text-ink-soft">
        Transcode a video and publish it, and it will appear here. For a local test run:
      </p>
      <code className="rounded-lg bg-mist px-3 py-2 text-left text-xs font-semibold">npm run seed:video</code>
      <Link href="/api/health" className="text-sm font-semibold text-primary hover:underline">
        Check service health
      </Link>
    </div>
  )
}
