import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { VideoGrid } from '@/components/Rail'
import { getCategory, listByCategory, listCategories } from '@/lib/queries/videos'

export const revalidate = 60

type Props = { params: Promise<{ slug: string }> }

/**
 * Category landing pages are a primary SEO surface (plan §7), so they are
 * statically generated at build time and revalidated rather than rendered per
 * request.
 */
export async function generateStaticParams() {
  const categories = await listCategories()
  return categories.map((category) => ({ slug: category.slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const category = await getCategory((await params).slug)
  if (!category) return { title: 'Category not found' }

  return {
    title: category.name,
    description: category.description ?? `Watch free ${category.name.toLowerCase()} online.`,
    alternates: { canonical: `/c/${category.slug}` },
  }
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params
  const category = await getCategory(slug)
  if (!category) notFound()

  const { items } = await listByCategory(slug, 30)

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{category.name}</h1>
      {category.description ? (
        <p className="mt-1 text-sm text-neutral-500">{category.description}</p>
      ) : null}

      <div className="mt-6">
        {items.length > 0 ? (
          <VideoGrid videos={items} />
        ) : (
          <p className="py-12 text-center text-sm text-neutral-500">
            Nothing published in this category yet.
          </p>
        )}
      </div>
    </div>
  )
}
