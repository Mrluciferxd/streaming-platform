import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EpisodeList } from '@/components/EpisodeList'
import { getSeriesBySlug, listSeriesSlugs, type SeriesStatus } from '@/lib/queries/series'

export const revalidate = 300

type Props = { params: Promise<{ slug: string }> }

/**
 * The series page is the canonical URL for a show — what a viewer links to and
 * what search results should land on, rather than an arbitrary episode. Static
 * with revalidation for the same reason category pages are.
 */
export async function generateStaticParams() {
  const slugs = await listSeriesSlugs()
  return slugs.map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const series = await getSeriesBySlug((await params).slug)
  if (!series) return { title: 'Series not found' }

  const description =
    series.synopsis?.slice(0, 160) ?? `Watch every episode of ${series.title} free.`
  const image = series.bannerUrl ?? series.portraitUrl ?? series.posterUrl

  return {
    title: series.title,
    description,
    alternates: { canonical: `/series/${series.slug}` },
    openGraph: {
      type: 'video.tv_show',
      title: series.title,
      description,
      images: image ? [image] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title: series.title,
      description,
      images: image ? [image] : undefined,
    },
  }
}

const STATUS_LABEL: Record<SeriesStatus, string> = {
  announced: 'Announced',
  airing: 'Airing now',
  hiatus: 'On break',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export default async function SeriesPage({ params }: Props) {
  const { slug } = await params
  const series = await getSeriesBySlug(slug)
  if (!series) notFound()

  const first = series.episodes[0]
  const art = series.portraitUrl ?? series.posterUrl

  /**
   * schema.org TVSeries. The episode-level VideoObject already lives on each
   * watch page; this is what ties them together so a search result can show the
   * show rather than one arbitrary episode of it.
   */
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'TVSeries',
    name: series.title,
    description: series.synopsis ?? undefined,
    image: art ? [art] : undefined,
    numberOfEpisodes: series.totalEpisodes ?? series.episodes.length,
    numberOfSeasons: series.seasons.length,
    productionCompany: series.studio ? { '@type': 'Organization', name: series.studio } : undefined,
    datePublished: series.releaseYear ? String(series.releaseYear) : undefined,
  }

  return (
    <div className="pb-16">
      <script
        type="application/ld+json"
        // Server-generated from our own database, never from user input at render time.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <section className="relative overflow-hidden px-4 pt-24 pb-8 sm:px-8 sm:pt-28 lg:px-12">
        {/*
          The banner sits behind the panel and heavily washed out, not as a
          full-bleed header. Key art is busy, and text laid straight over it is
          unreadable on exactly the saturated artwork this catalogue is full of.
        */}
        {series.bannerUrl ? (
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
            <Image
              src={series.bannerUrl}
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover opacity-25"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-canvas/60 via-canvas/80 to-canvas" />
          </div>
        ) : (
          <div aria-hidden className="aurora pointer-events-none absolute inset-0 -z-10" />
        )}

        <div className="relative mx-auto grid max-w-6xl gap-8 rounded-[2rem] bg-surface/70 p-6 shadow-[0_24px_60px_-30px_rgba(124,107,240,0.45)] ring-1 ring-white/60 backdrop-blur-xl sm:p-10 lg:grid-cols-[16rem_1fr] lg:gap-12">
          <div className="mx-auto w-40 shrink-0 sm:w-52 lg:w-full">
            <div className="relative aspect-2/3 overflow-hidden rounded-3xl shadow-[0_20px_50px_-20px_rgba(46,42,53,0.5)] ring-4 ring-white">
              {art ? (
                <Image
                  src={art}
                  alt=""
                  fill
                  priority
                  sizes="(max-width: 1024px) 13rem, 16rem"
                  className="object-cover"
                />
              ) : (
                <div className="h-full w-full bg-mist" />
              )}
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={series.status} />
              {series.seasonLabel ? (
                <span className="rounded-full bg-secondary-soft px-3 py-1 text-[11px] font-bold text-secondary">
                  {series.seasonLabel}
                </span>
              ) : null}
            </div>

            <h1 className="mt-4 font-display text-3xl leading-[1.05] font-extrabold tracking-tight text-ink sm:text-5xl">
              {series.title}
            </h1>

            <dl className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-ink-soft">
              <Fact label="Episodes">
                {/*
                  Available over announced, because while a show airs those are
                  different numbers and the gap is the thing a viewer is checking.
                */}
                {series.totalEpisodes && series.totalEpisodes > series.episodes.length
                  ? `${series.episodes.length} of ${series.totalEpisodes}`
                  : series.episodes.length}
              </Fact>
              {series.studio ? <Fact label="Studio">{series.studio}</Fact> : null}
              {series.releaseYear ? <Fact label="Year">{series.releaseYear}</Fact> : null}
            </dl>

            {series.synopsis ? (
              <p className="mt-4 max-w-2xl text-sm leading-relaxed whitespace-pre-line text-ink-soft sm:text-base">
                {series.synopsis}
              </p>
            ) : null}

            {first ? (
              <div className="mt-6">
                <Link
                  href={`/watch/${first.slug}`}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3 text-sm font-bold text-white shadow-lg shadow-primary/30 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/40 sm:text-base"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  Watch episode {first.episodeNo}
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-8 lg:px-12">
        {series.seasons.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted">
            No episodes have been published yet.
          </p>
        ) : (
          series.seasons.map((season) => (
            <div key={season.seasonNo} className="mt-8 first:mt-0">
              <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-extrabold tracking-tight text-ink md:text-xl">
                <span className="h-5 w-1.5 rounded-full bg-primary" aria-hidden />
                {/* A single-season show has no seasons to choose between, so naming one is just noise. */}
                {series.seasons.length > 1 ? `Season ${season.seasonNo}` : 'Episodes'}
                <span className="text-sm font-semibold text-muted">{season.episodes.length}</span>
              </h2>

              <EpisodeList episodes={season.episodes} />
            </div>
          ))
        )}
      </section>
    </div>
  )
}

function StatusPill({ status }: { status: SeriesStatus }) {
  // Airing is the state a viewer scans for, so it is the only one in brand pink.
  const tone =
    status === 'airing'
      ? 'bg-primary text-white'
      : status === 'completed'
        ? 'bg-accent-soft text-accent'
        : 'bg-mist text-ink-soft'

  return (
    <span className={`rounded-full px-3 py-1 text-[11px] font-extrabold tracking-wider ${tone}`}>
      {STATUS_LABEL[status].toUpperCase()}
    </span>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</dt>
      <dd className="font-semibold text-ink">{children}</dd>
    </div>
  )
}
