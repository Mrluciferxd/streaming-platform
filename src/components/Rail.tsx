import Link from 'next/link'

import { VideoCard } from '@/components/VideoCard'
import type { VideoCard as VideoCardData } from '@/lib/queries/videos'

/**
 * Horizontally scrolling row of cards.
 *
 * Native overflow scrolling with snap points rather than a carousel library:
 * it works without JavaScript, keeps keyboard and screen-reader behaviour
 * intact, and adds nothing to the bundle.
 */
export function Rail({
  title,
  href,
  videos,
  priority = false,
}: {
  title: string
  href?: string
  videos: VideoCardData[]
  priority?: boolean
}) {
  if (videos.length === 0) return null

  return (
    <section className="py-4">
      <div className="mb-3 flex items-baseline justify-between gap-4 px-4 sm:px-6">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {href ? (
          <Link href={href} className="text-sm text-neutral-500 hover:text-red-600">
            See all
          </Link>
        ) : null}
      </div>

      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:px-6 [scrollbar-width:thin]">
        {videos.map((video, index) => (
          <div key={video.id} className="w-40 shrink-0 snap-start sm:w-52 lg:w-60">
            <VideoCard video={video} priority={priority && index < 4} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Responsive grid, for category and search results. */
export function VideoGrid({ videos }: { videos: VideoCardData[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {videos.map((video, index) => (
        <VideoCard key={video.id} video={video} priority={index < 6} />
      ))}
    </div>
  )
}
