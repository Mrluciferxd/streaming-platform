import Image from 'next/image'
import Link from 'next/link'

import { formatRuntime } from '@/lib/format'
import type { EpisodeListItem } from '@/lib/queries/series'

/**
 * The episode picker.
 *
 * One component serves both the full-width series page and the 340px watch-page
 * sidebar, sized by container queries rather than by a `compact` prop — the two
 * layouts differ only in how much room they have, and a boolean would encode
 * that as a decision the caller has to keep making correctly.
 *
 * Deliberately not a client component. Which episode is playing is known on the
 * server from the URL, so nothing here needs state, and the watch route is
 * already paying for hls.js.
 */
export function EpisodeList({
  episodes,
  currentVideoId,
}: {
  episodes: EpisodeListItem[]
  currentVideoId?: string
}) {
  if (episodes.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">No episodes available yet.</p>
  }

  return (
    <ol className="@container flex flex-col gap-2">
      {episodes.map((episode) => {
        const current = episode.videoId === currentVideoId

        return (
          <li key={episode.videoId}>
            <Link
              href={`/watch/${episode.slug}`}
              prefetch={false}
              aria-current={current ? 'page' : undefined}
              className={`group flex gap-3 rounded-2xl p-2 transition outline-none focus-visible:ring-3 focus-visible:ring-primary/50 ${
                current
                  ? 'bg-primary-soft ring-1 ring-primary/40'
                  : 'hover:bg-mist'
              }`}
            >
              <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-xl bg-mist @md:w-40">
                {episode.thumbnailUrl ? (
                  <Image
                    src={episode.thumbnailUrl}
                    alt=""
                    fill
                    sizes="(max-width: 640px) 30vw, 160px"
                    className="object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                ) : null}

                {current ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/45">
                    <EqualizerGlyph className="h-5 w-5 text-white" />
                  </span>
                ) : null}

                {episode.durationSec ? (
                  <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-white tabular-nums">
                    {formatRuntime(episode.durationSec)}
                  </span>
                ) : null}
              </div>

              <div className="min-w-0 flex-1 py-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={`text-[11px] font-extrabold tracking-wider ${
                      current ? 'text-primary' : 'text-muted'
                    }`}
                  >
                    EP {episode.episodeNo}
                  </span>
                  {current ? (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-white">
                      NOW PLAYING
                    </span>
                  ) : null}
                </div>

                <h3
                  className={`mt-0.5 line-clamp-2 font-display text-sm leading-snug font-semibold ${
                    current ? 'text-primary' : 'text-ink group-hover:text-primary'
                  }`}
                >
                  {episode.title}
                </h3>

                {/* Only where there is width for it — in the sidebar it is noise. */}
                {episode.synopsis ? (
                  <p className="mt-1 hidden text-xs leading-relaxed text-ink-soft @md:line-clamp-2">
                    {episode.synopsis}
                  </p>
                ) : null}

                {episode.airedAt ? (
                  <p className="mt-1 text-[11px] text-muted">{formatAirDate(episode.airedAt)}</p>
                ) : null}
              </div>
            </Link>
          </li>
        )
      })}
    </ol>
  )
}

/** Fixed locale so a server render and a static build agree on the string. */
function formatAirDate(date: Date): string {
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function EqualizerGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="10" width="4" height="10" rx="1" />
      <rect x="10" y="5" width="4" height="15" rx="1" />
      <rect x="17" y="13" width="4" height="7" rx="1" />
    </svg>
  )
}
