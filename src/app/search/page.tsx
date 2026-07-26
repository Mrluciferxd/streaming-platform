import type { Metadata } from 'next'

import { TitleGrid } from '@/components/Row'
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
    <div className="px-4 pt-28 pb-16 sm:px-12">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        {query ? (
          <>
            Results for <span className="text-[#e50914]">{query}</span>
          </>
        ) : (
          'Search'
        )}
      </h1>

      <div className="mt-6">
        {!query ? (
          <p className="text-sm text-[#b3b3b3]">Type something in the search box above.</p>
        ) : items.length > 0 ? (
          <>
            <p className="mb-5 text-sm text-[#b3b3b3]">
              {items.length} result{items.length === 1 ? '' : 's'}
            </p>
            <TitleGrid videos={items} />
          </>
        ) : (
          <p className="py-16 text-center text-sm text-[#808080]">
            Nothing matched “{query}”. Try a different spelling or a broader term.
          </p>
        )}
      </div>
    </div>
  )
}
