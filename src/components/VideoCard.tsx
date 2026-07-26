import Image from 'next/image'
import Link from 'next/link'

import { formatTime } from '@/components/player/formatTime'
import type { VideoCard as VideoCardData } from '@/lib/queries/videos'

/**
 * Grid/rail card.
 *
 * Every element that affects layout has explicit dimensions and the poster sits
 * in a fixed aspect-ratio box, so images arriving late never shift the page —
 * plan §8 caps Cumulative Layout Shift at 0.1, and thumbnail grids are the
 * usual way sites blow past it.
 */
export function VideoCard({ video, priority = false }: { video: VideoCardData; priority?: boolean }) {
  return (
    <Link
      href={`/watch/${video.slug}`}
      className="group block focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:outline-none rounded-lg"
      // Prefetching on hover/touch-start makes the watch page feel instant
      // (plan §8). Next does this by default for viewport links; stating it here
      // keeps the intent visible.
      prefetch
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-neutral-200 dark:bg-neutral-800">
        {video.posterUrl ? (
          <Image
            src={video.posterUrl}
            alt=""
            fill
            // Tells the optimiser what to actually generate, instead of shipping
            // a desktop-width image to a phone.
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 240px"
            className="object-cover transition-transform duration-300 group-hover:scale-105"
            priority={priority}
            loading={priority ? undefined : 'lazy'}
          />
        ) : null}

        {video.durationSec ? (
          <span className="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
            {formatTime(video.durationSec)}
          </span>
        ) : null}

        {/* IT Rules 2021 requires the classification to be visible up front. */}
        {video.ageRating !== 'U' ? (
          <span className="absolute top-1.5 left-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {formatRating(video.ageRating)}
          </span>
        ) : null}
      </div>

      <h3 className="mt-2 line-clamp-2 text-sm font-medium text-neutral-900 group-hover:text-red-600 dark:text-neutral-100">
        {video.title}
      </h3>

      <p className="mt-0.5 text-xs text-neutral-500">
        {formatViews(video.viewCount)}
        {video.publishedAt ? ` · ${formatRelative(video.publishedAt)}` : ''}
      </p>
    </Link>
  )
}

function formatRating(rating: string): string {
  return rating.startsWith('UA') ? `U/A ${rating.slice(2)}+` : rating
}

/** Indian numbering: thousands, then lakh and crore. */
function formatViews(count: number): string {
  if (count >= 10_000_000) return `${(count / 10_000_000).toFixed(1)} Cr views`
  if (count >= 100_000) return `${(count / 100_000).toFixed(1)} L views`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K views`
  return `${count} view${count === 1 ? '' : 's'}`
}

function formatRelative(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)

  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [31_536_000, 'year'],
    [2_592_000, 'month'],
    [604_800, 'week'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ]

  const formatter = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' })

  for (const [size, unit] of units) {
    if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit)
  }

  return 'just now'
}
