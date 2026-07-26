'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { TitleCard } from '@/components/TitleCard'
import type { VideoCard as VideoCardData } from '@/lib/queries/videos'

/**
 * A horizontally scrolling row of titles.
 *
 * Native overflow scrolling with snap points and chevron buttons layered over
 * it, rather than a carousel library: it works before JavaScript loads, keyboard
 * and screen readers get real scroll semantics for free, and it adds nothing to
 * the bundle on a page that already has to stay under the §8 budget.
 *
 * Chevrons only appear when there is somewhere to go, and only on pointer
 * devices — on touch the gesture is the affordance.
 */
export function Row({
  title,
  videos,
  priority = false,
  ranked = false,
}: {
  title: string
  videos: VideoCardData[]
  priority?: boolean
  ranked?: boolean
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return

    setCanScrollLeft(el.scrollLeft > 8)
    // The 8px slack absorbs sub-pixel rounding, which otherwise leaves the
    // right chevron enabled forever at the end of a row.
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8)
  }, [])

  useEffect(() => {
    measure()
    const el = scrollerRef.current
    if (!el) return

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure, videos.length])

  const page = useCallback((direction: -1 | 1) => {
    const el = scrollerRef.current
    if (!el) return

    // Leave a sliver of the outgoing tile visible so the row reads as
    // continuous rather than paginated.
    el.scrollBy({ left: direction * (el.clientWidth * 0.85), behavior: 'smooth' })
  }, [])

  if (videos.length === 0) return null

  return (
    <section className="group/row relative py-3">
      <h2 className="mb-1 flex items-center gap-2 px-4 font-display text-lg font-extrabold tracking-tight text-ink sm:px-12 md:text-xl">
        <span className="h-5 w-1.5 rounded-full bg-primary" aria-hidden />
        {title}
      </h2>

      <div className="relative">
        <Chevron
          side="left"
          visible={canScrollLeft}
          onClick={() => page(-1)}
          label={`Scroll ${title} left`}
        />

        <div
          ref={scrollerRef}
          onScroll={measure}
          className="no-scrollbar flex snap-x gap-3 overflow-x-auto scroll-smooth px-4 py-5 sm:px-12"
        >
          {videos.map((video, index) => (
            <div
              key={video.id}
              className={`shrink-0 snap-start ${
                ranked
                  ? 'w-[11.5rem] sm:w-[14rem]'
                  : 'w-[8.5rem] sm:w-[10rem] lg:w-[11.5rem]'
              }`}
            >
              <TitleCard
                video={video}
                priority={priority && index < 5}
                rank={ranked ? index + 1 : undefined}
              />
            </div>
          ))}
        </div>

        <Chevron
          side="right"
          visible={canScrollRight}
          onClick={() => page(1)}
          label={`Scroll ${title} right`}
        />
      </div>
    </section>
  )
}

function Chevron({
  side,
  visible,
  onClick,
  label,
}: {
  side: 'left' | 'right'
  visible: boolean
  onClick: () => void
  label: string
}) {
  if (!visible) return null

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute top-1/2 z-30 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface text-ink shadow-lg ring-1 ring-line opacity-0 transition-all duration-200 group-hover/row:opacity-100 focus-visible:opacity-100 hover:bg-primary hover:text-white md:flex ${
        side === 'left' ? 'left-2 sm:left-5' : 'right-2 sm:right-5'
      }`}
    >
      <svg
        className="h-6 w-6"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={side === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
      </svg>
    </button>
  )
}

/** Grid for category and search pages, where browsing beats scrubbing. */
export function TitleGrid({ videos }: { videos: VideoCardData[] }) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-7 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
      {videos.map((video, index) => (
        <TitleCard key={video.id} video={video} priority={index < 6} />
      ))}
    </div>
  )
}
