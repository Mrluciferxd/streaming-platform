import Link from 'next/link'

import { SearchBox } from '@/components/SearchBox'
import { listCategories } from '@/lib/queries/videos'

export async function SiteHeader() {
  const categories = await listCategories()

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white/90 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="shrink-0 text-lg font-bold tracking-tight">
          <span className="text-red-600">▶</span> Streaming
        </Link>

        <div className="ml-auto w-full max-w-md">
          <SearchBox />
        </div>
      </div>

      <nav
        aria-label="Categories"
        className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 text-sm sm:px-6 [scrollbar-width:none]"
      >
        {categories.map((category) => (
          <Link
            key={category.id}
            href={`/c/${category.slug}`}
            className="shrink-0 rounded-full px-3 py-1 whitespace-nowrap text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            {category.name}
          </Link>
        ))}
      </nav>
    </header>
  )
}
