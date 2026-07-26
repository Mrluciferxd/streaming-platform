import type { MetadataRoute } from 'next'
import { and, desc, eq, isNull } from 'drizzle-orm'

import { db, categories, videos } from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'

/**
 * Dynamic sitemap (plan §7).
 *
 * Organic search is projected to be the largest traffic source, and a video
 * catalogue's watch pages are almost never reachable by crawling alone — they
 * sit behind horizontally scrolled rows that a crawler will not exhaust. The
 * sitemap is what actually gets them indexed.
 *
 * Search result pages are excluded on purpose: thin, near-duplicate, and a
 * crawl-budget sink.
 */
export const revalidate = 3600

// Sitemaps are capped at 50,000 URLs. Well beyond the current library, but the
// limit is real and the failure at that size is a rejected sitemap.
const MAX_URLS = 45_000

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://streaming-platform-red.vercel.app')
    .replace(/\/+$/, '')

  const [published, allCategories] = await Promise.all([
    db
      .select({ slug: videos.slug, updatedAt: videos.updatedAt, publishedAt: videos.publishedAt })
      .from(videos)
      .where(publiclyVisible)
      .orderBy(desc(videos.publishedAt))
      .limit(MAX_URLS),
    db.select({ slug: categories.slug }).from(categories),
  ])

  return [
    { url: base, lastModified: new Date(), changeFrequency: 'daily', priority: 1 },

    ...allCategories.map((category) => ({
      url: `${base}/c/${category.slug}`,
      lastModified: new Date(),
      changeFrequency: 'daily' as const,
      priority: 0.8,
    })),

    ...published.map((video) => ({
      url: `${base}/watch/${video.slug}`,
      lastModified: video.updatedAt ?? video.publishedAt ?? new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ]
}
