import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { WatchPlayer } from '@/components/player/WatchPlayer'
import { VideoCard } from '@/components/VideoCard'
import { getVideoBySlug, listRelated } from '@/lib/queries/videos'

export const revalidate = 300

type Props = { params: Promise<{ slug: string }> }

/**
 * SEO metadata. Organic search is projected to be the largest traffic source
 * (plan §4), so this is load-bearing rather than decoration.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const video = await getVideoBySlug((await params).slug)
  if (!video || video.status !== 'published') return { title: 'Video not found' }

  const description = video.description?.slice(0, 160) ?? `Watch ${video.title} free.`

  return {
    title: video.title,
    description,
    alternates: { canonical: `/watch/${video.slug}` },
    openGraph: {
      type: 'video.other',
      title: video.title,
      description,
      images: video.posterUrl ? [video.posterUrl] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title: video.title,
      description,
      images: video.posterUrl ? [video.posterUrl] : undefined,
    },
  }
}

export default async function WatchPage({ params }: Props) {
  const { slug } = await params
  const video = await getVideoBySlug(slug)

  if (!video || video.status !== 'published') notFound()

  const related = await listRelated(video.id)

  /**
   * schema.org VideoObject (plan §7). This is what puts a thumbnail, duration
   * and upload date on the Google result rather than a plain blue link, and it
   * is the single highest-leverage SEO item for a video site.
   */
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: video.title,
    description: video.description ?? undefined,
    thumbnailUrl: video.posterUrl ? [video.posterUrl] : undefined,
    uploadDate: video.publishedAt?.toISOString(),
    duration: video.durationSec ? `PT${Math.floor(video.durationSec / 60)}M${video.durationSec % 60}S` : undefined,
    contentRating: formatRating(video.ageRating),
    inLanguage: video.language,
    interactionStatistic: {
      '@type': 'InteractionCounter',
      interactionType: { '@type': 'WatchAction' },
      userInteractionCount: video.viewCount,
    },
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
      <script
        type="application/ld+json"
        // Server-generated from our own database, never from user input at render time.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <WatchPlayer slug={video.slug} posterUrl={video.posterUrl} />

          <h1 className="mt-4 text-xl font-semibold tracking-tight">{video.title}</h1>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
            <span>{video.viewCount.toLocaleString('en-IN')} views</span>
            <span aria-hidden>·</span>
            <span className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs font-semibold dark:border-neutral-700">
              {formatRating(video.ageRating)}
            </span>
            {video.categories.map((category) => (
              <Link
                key={category.slug}
                href={`/c/${category.slug}`}
                className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs transition hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              >
                {category.name}
              </Link>
            ))}
          </div>

          {/*
            IT Rules 2021 requires the classification and a content descriptor to
            be displayed at the start of every programme so viewers can make an
            informed choice (plan §10).
          */}
          {video.contentDescriptor ? (
            <p className="mt-2 text-xs text-neutral-500">
              <span className="font-medium">Content advisory:</span> {video.contentDescriptor}
            </p>
          ) : null}

          {video.description ? (
            <p className="mt-4 text-sm whitespace-pre-line text-neutral-700 dark:text-neutral-300">
              {video.description}
            </p>
          ) : null}
        </div>

        <aside className="min-w-0">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">Related</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            {related.map((item) => (
              <VideoCard key={item.id} video={item} />
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}

function formatRating(rating: string): string {
  return rating.startsWith('UA') ? `U/A ${rating.slice(2)}+` : rating
}
