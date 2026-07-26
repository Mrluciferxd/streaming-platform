import Image from 'next/image'
import Link from 'next/link'

import { MyListButton } from '@/components/MyListButton'
import { formatRating, formatRuntime, languageLabel } from '@/lib/format'
import type { VideoCard as VideoCardData } from '@/lib/queries/videos'

/**
 * The billboard.
 *
 * Built as a light, floating panel rather than the full-bleed dark slab a
 * cinema catalogue uses. On a light page a hard-edged full-bleed image reads as
 * a banner ad; inset and rounded, with the artwork held inside a card, it reads
 * as a feature.
 *
 * The key visual sits on the right at its native portrait ratio instead of
 * being stretched across the width, because that is the shape the art is drawn
 * in — and a 2:3 composition cropped to a 21:9 band loses the character it was
 * built around.
 */
export function Hero({
  video,
  description,
  signedIn = false,
  inList = false,
}: {
  video: VideoCardData
  description?: string | null
  signedIn?: boolean
  inList?: boolean
}) {
  const art = video.portraitUrl ?? video.posterUrl

  return (
    <section className="relative overflow-hidden px-4 pt-24 pb-10 sm:px-8 sm:pt-28 lg:px-12">
      {/* Decorative wash. Two radial gradients, no image — see .aurora. */}
      <div aria-hidden className="aurora pointer-events-none absolute inset-0 -z-10" />

      <div className="relative mx-auto grid max-w-6xl items-center gap-8 rounded-[2rem] bg-surface/70 p-6 shadow-[0_24px_60px_-30px_rgba(124,107,240,0.45)] ring-1 ring-white/60 backdrop-blur-xl sm:p-10 lg:grid-cols-[1fr_18rem] lg:gap-12">
        <div className="min-w-0 order-2 lg:order-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary px-3 py-1 text-[11px] font-extrabold tracking-wider text-white">
              FEATURED
            </span>
            {video.seasonLabel ? (
              <span className="rounded-full bg-secondary-soft px-3 py-1 text-[11px] font-bold text-secondary">
                {video.seasonLabel}
              </span>
            ) : null}
            {video.hasSub ? <Tag tone="secondary">SUB</Tag> : null}
            {video.hasDub ? <Tag tone="accent">DUB</Tag> : null}
          </div>

          <h1 className="mt-4 font-display text-3xl leading-[1.05] font-extrabold tracking-tight text-ink sm:text-5xl">
            {video.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm font-medium text-ink-soft">
            {video.score !== null && video.score !== undefined ? (
              <span className="flex items-center gap-1 font-bold text-[#f59e0b]">
                ★ {(video.score / 10).toFixed(1)}
              </span>
            ) : null}
            <span className="rounded-md bg-mist px-2 py-0.5 text-xs font-bold">
              {formatRating(video.ageRating)}
            </span>
            {video.durationSec ? <span>{formatRuntime(video.durationSec)}</span> : null}
            <span>{languageLabel(video.language)}</span>
          </div>

          {description ? (
            <p className="mt-4 line-clamp-3 max-w-xl text-sm leading-relaxed text-ink-soft sm:text-base">
              {description}
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href={`/watch/${video.slug}`}
              className="flex items-center gap-2 rounded-full bg-primary px-7 py-3 text-sm font-bold text-white shadow-lg shadow-primary/30 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/40 sm:text-base"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              Watch now
            </Link>

<MyListButton
              videoId={video.id}
              initiallyInList={inList}
              signedIn={signedIn}
              returnTo="/"
            />
          </div>
        </div>

        <div className="order-1 mx-auto w-44 shrink-0 sm:w-56 lg:order-2 lg:w-full">
          <div className="relative aspect-2/3 overflow-hidden rounded-3xl shadow-[0_20px_50px_-20px_rgba(46,42,53,0.5)] ring-4 ring-white">
            {art ? (
              <Image
                src={art}
                alt=""
                fill
                // Largest Contentful Paint element on the home page (plan §8
                // targets LCP under 2.0s), so it is fetched eagerly.
                priority
                sizes="(max-width: 1024px) 14rem, 18rem"
                className="object-cover"
              />
            ) : (
              <div className="h-full w-full bg-mist" />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function Tag({ tone, children }: { tone: 'secondary' | 'accent'; children: React.ReactNode }) {
  const tones = {
    secondary: 'bg-secondary text-white',
    accent: 'bg-accent text-white',
  } as const

  return (
    <span className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  )
}
