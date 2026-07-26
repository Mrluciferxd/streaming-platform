import Image from 'next/image'
import Link from 'next/link'

import { formatRating, formatRuntime, languageLabel } from '@/lib/format'
import type { VideoCard as VideoCardData } from '@/lib/queries/videos'

/**
 * The billboard.
 *
 * A catalogue home page has to answer "what should I watch?" before it answers
 * "what is here?" — so one title gets the top of the screen at full bleed, with
 * everything else scrolling underneath it. This is the piece that most
 * separates a lean-back catalogue from a feed.
 *
 * Two gradients, both load-bearing rather than decorative: a left-to-right scrim
 * so the copy stays legible over whatever the artwork happens to be doing, and a
 * bottom fade that dissolves the image into the first row so there is no seam.
 */
export function Hero({ video, description }: { video: VideoCardData; description?: string | null }) {
  return (
    <section className="relative -mt-[68px] h-[56.25vw] max-h-[80vh] min-h-[420px] w-full">
      <div className="absolute inset-0">
        {video.posterUrl ? (
          <Image
            src={video.posterUrl}
            alt=""
            fill
            // The billboard is the Largest Contentful Paint element on the home
            // page, so it is fetched eagerly at top priority (plan §8 targets
            // LCP under 2.0s).
            priority
            sizes="100vw"
            className="object-cover object-top"
          />
        ) : (
          <div className="h-full w-full bg-neutral-900" />
        )}

        {/*
          Three scrims, all load-bearing.

          Left-to-right keeps the copy legible over whatever the artwork is
          doing. Bottom-up dissolves the image into the first row — it runs the
          full lower half with a mid-stop rather than a short fade, because a
          short one leaves a visible horizontal seam where the billboard ends
          and the page background begins. A light overall darkening keeps bright
          posters from overpowering the white Play button.
        */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/55 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-[#141414] via-[#141414]/70 to-transparent" />
        <div className="absolute inset-0 bg-black/15" />
      </div>

      {/*
        Lower third, not centred. The billboard is a poster with copy laid over
        it, so the copy sits where a poster's title treatment would — anchored
        near the bottom, leaving the upper frame to the image.
      */}
      <div className="relative flex h-full flex-col justify-end pb-[18%] sm:pb-[14%]">
        <div className="max-w-xl px-4 sm:px-12">
          <h1 className="text-3xl leading-none font-black tracking-tight drop-shadow-2xl sm:text-5xl lg:text-6xl">
            {video.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-2.5 text-sm text-white/80">
            <span className="rounded-xs border border-white/40 px-1.5 py-px text-xs">
              {formatRating(video.ageRating)}
            </span>
            {video.durationSec ? <span>{formatRuntime(video.durationSec)}</span> : null}
            <span>{languageLabel(video.language)}</span>
          </div>

          {description ? (
            <p className="mt-3 line-clamp-3 max-w-lg text-sm leading-relaxed text-white/90 drop-shadow-lg sm:text-base">
              {description}
            </p>
          ) : null}

          <div className="mt-5 flex items-center gap-3">
            <Link
              href={`/watch/${video.slug}`}
              className="flex items-center gap-2 rounded-sm bg-white px-6 py-2.5 text-sm font-semibold text-black transition hover:bg-white/80 sm:px-7 sm:text-base"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              Play
            </Link>

            <Link
              href={`/watch/${video.slug}`}
              className="flex items-center gap-2 rounded-sm bg-[#6d6d6e]/70 px-6 py-2.5 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-[#6d6d6e]/50 sm:px-7 sm:text-base"
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
              </svg>
              More Info
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
