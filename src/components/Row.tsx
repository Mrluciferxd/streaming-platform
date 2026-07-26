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
      <h2 className="mb-2 px-4 text-base font-medium text-[#e5e5e5] sm:px-12 md:text-lg">
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
          className="no-scrollbar flex snap-x gap-1.5 overflow-x-auto scroll-smooth px-4 py-6 sm:px-12"
        >
          {videos.map((video, index) => (
            <div
              key={video.id}
              className={`shrink-0 snap-start ${
                ranked
                  ? 'w-[15.5rem] sm:w-[19rem]'
                  : 'w-[9.5rem] sm:w-[13rem] lg:w-[15.5rem]'
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
      className={`absolute inset-y-6 z-30 hidden w-9 items-center justify-center bg-black/50 text-white opacity-0 transition-opacity duration-200 group-hover/row:opacity-100 focus-visible:opacity-100 hover:bg-black/75 md:flex sm:w-12 ${
        side === 'left' ? 'left-0' : 'right-0'
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
    <div className="grid grid-cols-2 gap-x-2 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {videos.map((video, index) => (
        <TitleCard key={video.id} video={video} priority={index < 6} />
      ))}
    </div>
  )
}
