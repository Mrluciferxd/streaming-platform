import type { Metadata } from 'next'

import { VideoGrid } from '@/components/Rail'
import { searchVideos } from '@/lib/queries/videos'

export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<{ q?: string }> }

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const query = (await searchParams).q?.trim() ?? ''

  return {
    title: query ? `Search: ${query}` : 'Search',
    // Search result pages are thin, near-duplicate content — indexing them
    // dilutes the pages that should rank and risks a crawl-budget problem.
    robots: { index: false, follow: true },
  }
}

export default async function SearchPage({ searchParams }: Props) {
  const query = (await searchParams).q?.trim() ?? ''
  const { items } = query ? await searchVideos(query, 30) : { items: [] }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <h1 className="text-xl font-semibold tracking-tight">
        {query ? (
          <>
            Results for <span className="text-red-600">{query}</span>
          </>
        ) : (
          'Search'
        )}
      </h1>

      <div className="mt-6">
        {!query ? (
          <p className="text-sm text-neutral-500">Type something in the search box above.</p>
        ) : items.length > 0 ? (
          <>
            <p className="mb-4 text-sm text-neutral-500">
              {items.length} result{items.length === 1 ? '' : 's'}
            </p>
            <VideoGrid videos={items} />
          </>
        ) : (
          <p className="py-12 text-center text-sm text-neutral-500">
            Nothing matched “{query}”. Try a different spelling or a broader term.
          </p>
        )}
      </div>
    </div>
  )
}
