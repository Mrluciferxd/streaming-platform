'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'

import { formatRating, formatRuntime, languageLabel } from '@/lib/format'
import type { VideoCard as VideoCardData } from '@/lib/queries/videos'

/**
 * Poster tile.
 *
 * Deliberately carries no view count and no upload date. Those are creator-feed
 * signals — they tell you how a video is doing. A catalogue interface is
 * answering a different question ("is this worth my evening?"), and the answer
 * is the artwork, the rating and the runtime. Everything else is noise on the
 * row.
 *
 * On hover the tile lifts into a card: the title, a short line of metadata, and
 * the two actions that matter. Nothing about the resting state moves, so a row
 * of tiles stays a clean grid until you engage with it.
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

  return (
    <Link
      href={`/watch/${video.slug}`}
      prefetch
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className="group relative block rounded-sm outline-none"
      aria-label={video.title}
    >
      <div className="relative flex items-end">
        {rank !== undefined ? (
          <span
            aria-hidden
            className="rank-numeral shrink-0 select-none text-[5.5rem] tracking-tighter sm:text-[7rem]"
          >
            {rank}
          </span>
        ) : null}

        <div
          className={`relative aspect-video w-full overflow-hidden rounded-sm bg-neutral-800 transition-[transform,box-shadow] duration-300 ease-out ${
            hovered ? 'z-20 scale-[1.06] shadow-2xl shadow-black/80' : 'z-0 scale-100'
          }`}
        >
          {video.posterUrl ? (
            <Image
              src={video.posterUrl}
              alt=""
              fill
              sizes="(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 320px"
              className="object-cover"
              priority={priority}
              loading={priority ? undefined : 'lazy'}
            />
          ) : null}

          {/* Scrim so overlaid text stays legible on bright artwork. */}
          <div
            className={`absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent transition-opacity duration-300 ${
              hovered ? 'opacity-100' : 'opacity-70'
            }`}
          />

          {video.durationSec ? (
            <span className="absolute top-2 right-2 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white/90">
              {formatRuntime(video.durationSec)}
            </span>
          ) : null}

          <div className="absolute inset-x-0 bottom-0 p-2.5">
            <h3 className="line-clamp-2 text-[13px] leading-tight font-semibold drop-shadow-lg">
              {video.title}
            </h3>

            <div
              className={`grid transition-[grid-template-rows,opacity] duration-300 ${
                hovered ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden">
                <div className="flex items-center gap-2 pt-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-black">
                    <PlayGlyph className="ml-0.5 h-3.5 w-3.5" />
                  </span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/50 text-white">
                    <PlusGlyph className="h-3.5 w-3.5" />
                  </span>
                </div>

                <p className="mt-2 flex items-center gap-1.5 text-[10px] text-white/70">
                  <span className="rounded-xs border border-white/40 px-1 py-px">
                    {formatRating(video.ageRating)}
                  </span>
                  <span className="uppercase">{languageLabel(video.language)}</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Link>
  )
}

type GlyphProps = { className?: string }

function PlayGlyph({ className }: GlyphProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function PlusGlyph({ className }: GlyphProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
}
