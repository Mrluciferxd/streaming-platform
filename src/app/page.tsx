import Link from 'next/link'

import { Hero } from '@/components/Hero'
import { Row } from '@/components/Row'
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
export const revalidate = 60

export const metadata = {
  title: 'Watch free regional films, series and shorts',
  description:
    'Free streaming of Gujarati and Hindi short films, features, web series, music and documentaries.',
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
  const featuredDetail = await getVideoBySlug(featured.slug)

  const categoryRows = await Promise.all(
    categories.map(async (category) => ({
      ...category,
      videos: (await listByCategory(category.slug, 12)).items,
    })),
  )

  return (
    <>
      <Hero video={featured} description={featuredDetail?.description} />

      {/* Pulled up into the hero's bottom fade so the first row emerges from
          the artwork rather than starting below a hard edge. */}
      <div className="relative z-10 -mt-[10vw] pb-16">
        <Row title="Trending Now" videos={trending} ranked priority />
        <Row title="New Releases" videos={latest.items} />

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
      <h1 className="text-3xl font-black tracking-tight">Nothing published yet</h1>
      <p className="text-sm text-[#b3b3b3]">
        Transcode a video and publish it, and it will appear here. For a local test run:
      </p>
      <code className="rounded bg-[#232323] px-3 py-2 text-left text-xs">npm run seed:video</code>
      <Link href="/api/health" className="text-sm text-[#e50914] hover:underline">
        Check service health
      </Link>
    </div>
  )
}
