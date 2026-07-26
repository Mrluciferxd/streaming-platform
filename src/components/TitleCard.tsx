'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'

import { formatRating, formatRuntime } from '@/lib/format'
import type { VideoCard as VideoCardData } from '@/lib/queries/videos'

/**
 * Portrait title card.
 *
 * 2:3, because that is the shape anime key art is drawn in and the shape every
 * anime catalogue displays it in. A landscape card would crop the character
 * composition — which is the entire selling point of a key visual — down to a
 * band across the middle.
 *
 * SUB and DUB sit on the resting card rather than behind a hover. For anime
 * viewers that is not trivia, it is the first filter applied: a dub-only viewer
 * scanning a subbed row is looking at nothing they can watch.
 */
export function TitleCard({
  video,
  priority = false,
  rank,
}: {
  video: VideoCardData
  priority?: boolean
  rank?: number
}) {
  const [hovered, setHovered] = useState(false)

  // Falls back to the 16:9 frame until real key art exists for the title.
  const art = video.portraitUrl ?? video.posterUrl

  return (
    <Link
      href={`/watch/${video.slug}`}
      prefetch
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className="group block rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-primary/50"
      aria-label={video.title}
    >
      {/*
        The numeral is positioned, not a flex sibling. As a sibling its width
        varied by digit — "1" is far narrower than "4" — which changed the
        poster's width, and with a fixed aspect ratio that changed its height
        too, leaving the whole ranked row visibly staggered.
      */}
      <div className={`relative ${rank !== undefined ? 'pl-9 sm:pl-11' : ''}`}>
        {rank !== undefined ? (
          <span
            aria-hidden
            className="rank-numeral pointer-events-none absolute bottom-4 left-0 z-0 select-none font-display text-[5.5rem] sm:text-[7rem]"
          >
            {rank}
          </span>
        ) : null}

        <div
          className={`relative z-10 aspect-2/3 w-full overflow-hidden rounded-2xl bg-mist transition-all duration-300 ease-out ${
            hovered
              ? '-translate-y-1.5 shadow-[0_18px_40px_-12px_rgba(255,92,138,0.45)]'
              : 'shadow-[0_6px_18px_-10px_rgba(46,42,53,0.35)]'
          }`}
        >
          {art ? (
            <Image
              src={art}
              alt=""
              fill
              sizes="(max-width: 640px) 40vw, (max-width: 1024px) 24vw, 210px"
              className="object-cover transition-transform duration-500 group-hover:scale-105"
              priority={priority}
              loading={priority ? undefined : 'lazy'}
            />
          ) : null}

          <div className="absolute top-2 left-2 flex flex-col gap-1">
            {video.hasSub ? <Pill tone="secondary">SUB</Pill> : null}
            {video.hasDub ? <Pill tone="accent">DUB</Pill> : null}
          </div>

          {video.score !== null && video.score !== undefined ? (
            <span className="absolute top-2 right-2 flex items-center gap-0.5 rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] font-bold text-ink shadow-sm backdrop-blur">
              <StarGlyph className="h-2.5 w-2.5 text-[#ffb020]" />
              {(video.score / 10).toFixed(1)}
            </span>
          ) : null}

          {/* Only deep enough to seat the badges; the artwork stays the subject. */}
          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/75 to-transparent" />

          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 p-2 text-[10px] font-semibold text-white/90">
            {video.seasonLabel ? <span>{video.seasonLabel}</span> : null}
            {video.durationSec ? (
              <>
                {video.seasonLabel ? <span aria-hidden>·</span> : null}
                <span>{formatRuntime(video.durationSec)}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <h3 className="mt-2 line-clamp-2 font-display text-sm leading-snug font-semibold text-ink transition-colors group-hover:text-primary">
        {video.title}
      </h3>

      <p className="mt-0.5 text-[11px] font-medium text-muted">
        {formatRating(video.ageRating)}
      </p>
    </Link>
  )
}

function Pill({ tone, children }: { tone: 'secondary' | 'accent'; children: React.ReactNode }) {
  const tones = {
    secondary: 'bg-secondary text-white',
    accent: 'bg-accent text-white',
  } as const

  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider shadow-sm ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

function StarGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l2.9 6.3 6.6.8-4.9 4.6 1.3 6.6L12 17l-5.9 3.3 1.3-6.6L2.5 9.1l6.6-.8z" />
    </svg>
  )
}
