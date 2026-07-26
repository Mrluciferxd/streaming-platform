import Link from 'next/link'

import { Rail } from '@/components/Rail'
import { listByCategory, listCategoriesWithVideos, listLatest, listTrending } from '@/lib/queries/videos'

/**
 * Homepage rails (plan §7 MVP).
 *
 * ISR with a 60s window: the content changes when something is published, not
 * per request, so nearly every visitor gets a static page from the edge. That is
 * what keeps TTFB under the 200 ms target in plan §8 without a cache layer in
 * front of the database.
 *
 * "Continue Watching" is deliberately absent here — it is per-viewer, and
 * putting it on a shared cached page would either leak one viewer's history to
 * another or make the page uncacheable. It renders client-side from localStorage
 * until accounts exist.
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
    listCategoriesWithVideos(4),
  ])

  const categoryRails = await Promise.all(
    categories.map(async (category) => ({
      ...category,
      videos: (await listByCategory(category.slug, 12)).items,
    })),
  )

  if (latest.items.length === 0) {
    return <EmptyLibrary />
  }

  return (
    <div className="mx-auto max-w-7xl py-4">
      <Rail title="Trending this week" videos={trending} priority />
      <Rail title="New releases" href="/latest" videos={latest.items} />

      {categoryRails.map((category) => (
        <Rail
          key={category.id}
          title={category.name}
          href={`/c/${category.slug}`}
          videos={category.videos}
        />
      ))}
    </div>
  )
}

function EmptyLibrary() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Nothing published yet</h1>
      <p className="text-sm text-neutral-500">
        Transcode a video and publish it, and it will appear here. For a local test run:
      </p>
      <code className="rounded bg-neutral-100 px-3 py-2 text-left text-xs dark:bg-neutral-900">
        npm run seed:video
      </code>
      <Link href="/api/health" className="text-sm text-red-600 hover:underline">
        Check service health
      </Link>
    </div>
  )
}
