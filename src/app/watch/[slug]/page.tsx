import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EpisodeList } from '@/components/EpisodeList'
import { WatchPlayer } from '@/components/player/WatchPlayer'
import { TitleCard } from '@/components/TitleCard'
import { formatRating, formatRuntime, languageLabel } from '@/lib/format'
import { getEpisodeContext } from '@/lib/queries/series'
import { isPubliclyVisible } from '@/lib/queries/visibility'
import { getVideoBySlug, listRelated } from '@/lib/queries/videos'

export const revalidate = 300

type Props = { params: Promise<{ slug: string }> }

/**
 * SEO metadata. Organic search is projected to be the largest traffic source
 * (plan §4), so this is load-bearing rather than decoration.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const video = await getVideoBySlug((await params).slug)
  if (!video || !isPubliclyVisible(video)) return { title: 'Video not found' }

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

  if (!video || !isPubliclyVisible(video)) notFound()

  const episode = await getEpisodeContext(video.id)

  /**
   * An episode's sidebar is its series, not a genre-matched rail. Someone on
   * episode 3 of a 24-episode show is looking for episode 4 — offering them a
   * different show entirely is answering a question they did not ask, and the
   * related query is skipped rather than fetched and thrown away.
   */
  const related = episode ? [] : await listRelated(video.id)
  const season = episode?.seasons.find((s) => s.seasonNo === episode.current.seasonNo)

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
    // Ties the episode to its show. `isPartOf` rather than a TVEpisode wrapper,
    // which would displace the VideoObject the video rich result depends on.
    isPartOf: episode
      ? { '@type': 'TVSeries', name: episode.series.title }
      : undefined,
    interactionStatistic: {
      '@type': 'InteractionCounter',
      interactionType: { '@type': 'WatchAction' },
      userInteractionCount: video.viewCount,
    },
  }

  return (
    <div className="px-4 pt-24 pb-16 sm:px-12">
      <script
        type="application/ld+json"
        // Server-generated from our own database, never from user input at render time.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <WatchPlayer
            slug={video.slug}
            posterUrl={video.posterUrl}
            nextEpisode={
              episode?.next
                ? {
                    slug: episode.next.slug,
                    episodeNo: episode.next.episodeNo,
                    title: episode.next.title,
                    thumbnailUrl: episode.next.thumbnailUrl,
                  }
                : null
            }
          />

          {episode ? (
            <Link
              href={`/series/${episode.series.slug}`}
              className="mt-5 inline-block font-display text-sm font-bold text-primary transition hover:underline"
            >
              {episode.series.title}
            </Link>
          ) : null}

          <h1
            className={`font-display text-2xl font-extrabold tracking-tight sm:text-4xl ${
              episode ? 'mt-1' : 'mt-5'
            }`}
          >
            {video.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-2.5 text-sm font-medium text-ink-soft">
            <span className="rounded-md bg-mist px-2 py-0.5 text-xs font-bold">
              {formatRating(video.ageRating)}
            </span>
            {video.durationSec ? <span>{formatRuntime(video.durationSec)}</span> : null}
            <span>{languageLabel(video.language)}</span>
            {video.categories.map((category) => (
              <Link
                key={category.slug}
                href={`/c/${category.slug}`}
                className="rounded-full bg-secondary-soft px-2.5 py-0.5 text-xs font-bold text-secondary transition hover:bg-secondary hover:text-white"
              >
                {category.name}
              </Link>
            ))}
          </div>

          {/*
            The same affordance the player offers when the episode ends, present
            from the start — a viewer who already knows they want the next one
            should not have to sit through the credits to reach it.
          */}
          {episode?.next ? (
            <Link
              href={`/watch/${episode.next.slug}`}
              className="group mt-5 flex max-w-md items-center gap-3 rounded-2xl bg-surface p-2 shadow-[0_6px_18px_-10px_rgba(46,42,53,0.35)] ring-1 ring-line transition hover:-translate-y-0.5 hover:ring-primary/40"
            >
              <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-xl bg-mist">
                {episode.next.thumbnailUrl ? (
                  <Image
                    src={episode.next.thumbnailUrl}
                    alt=""
                    fill
                    sizes="96px"
                    className="object-cover"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 pr-2">
                <p className="text-[10px] font-extrabold tracking-wider text-muted">NEXT EPISODE</p>
                <p className="mt-0.5 line-clamp-1 font-display text-sm font-semibold text-ink transition-colors group-hover:text-primary">
                  <span className="text-primary">EP {episode.next.episodeNo}</span>{' '}
                  {episode.next.title}
                </p>
              </div>
              <svg
                className="h-5 w-5 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-primary"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </Link>
          ) : null}

          {/*
            IT Rules 2021 requires the classification and a content descriptor to
            be displayed at the start of every programme so viewers can make an
            informed choice (plan §10).
          */}
          {video.contentDescriptor ? (
            <p className="mt-3 text-xs text-muted">
              <span className="font-medium">Content advisory:</span> {video.contentDescriptor}
            </p>
          ) : null}

          {episode?.current.synopsis ?? video.description ? (
            <p className="mt-4 max-w-2xl text-sm leading-relaxed whitespace-pre-line text-ink-soft">
              {episode?.current.synopsis ?? video.description}
            </p>
          ) : null}
        </div>

        <aside className="min-w-0">
          {episode && season ? (
            <>
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <h2 className="font-display text-lg font-extrabold tracking-tight text-ink">
                  {episode.seasons.length > 1 ? `Season ${season.seasonNo}` : 'Episodes'}
                </h2>
                <Link
                  href={`/series/${episode.series.slug}`}
                  className="shrink-0 text-xs font-bold text-primary transition hover:underline"
                >
                  View series
                </Link>
              </div>
              {/*
                Capped and scrolled: a 24-episode list is taller than the player
                beside it, and letting it set the page height leaves the main
                column stranded in whitespace.
              */}
              <div className="max-h-[34rem] overflow-y-auto pr-1">
                <EpisodeList episodes={season.episodes} currentVideoId={video.id} />
              </div>
            </>
          ) : (
            <>
              <h2 className="mb-4 font-display text-lg font-extrabold tracking-tight text-ink">More Like This</h2>
              <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 lg:grid-cols-2">
                {related.map((item) => (
                  <TitleCard key={item.id} video={item} />
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
