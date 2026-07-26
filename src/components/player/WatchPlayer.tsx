'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { VideoPlayer } from './VideoPlayer'

type PlaybackResponse = {
  videoId: string
  title: string
  sessionId: string
  source: {
    masterUrl: string
    posterUrl: string | null
    spriteUrl: string | null
    spriteVttUrl: string | null
  }
}

export type NextEpisode = {
  slug: string
  episodeNo: number
  title: string
  thumbnailUrl: string | null
}

/**
 * How long the viewer has to say no.
 *
 * Long enough to read the title and reach the button on a phone, short enough
 * that someone who wants the next episode is not sitting through a delay. Ten
 * seconds is roughly where every player that does this has landed.
 */
const AUTOPLAY_SECONDS = 10

/**
 * Fetches playback details, then mounts the player.
 *
 * This runs client-side rather than on the server because the playback endpoint
 * sets the `pb` cookie that authorises every segment request at the CDN edge,
 * and a cached server-rendered page must never carry one viewer's token.
 *
 * It also keeps the watch page itself cacheable: the shell, metadata, and
 * related rail are static, and only this component is per-viewer.
 */
export function WatchPlayer({
  slug,
  posterUrl,
  nextEpisode,
}: {
  slug: string
  posterUrl: string | null
  nextEpisode?: NextEpisode | null
}) {
  const [data, setData] = useState<PlaybackResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch(`/api/playback/${encodeURIComponent(slug)}`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? 'unavailable' : 'failed')
        return (await response.json()) as PlaybackResponse
      })
      .then((payload) => {
        if (!cancelled) setData(payload)
      })
      .catch((cause: Error) => {
        if (cancelled) return
        setError(
          cause.message === 'unavailable'
            ? 'This video is not available.'
            : 'Could not start playback. Please try again.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [slug])

  if (error) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-neutral-900 text-sm text-neutral-300">
        {error}
      </div>
    )
  }

  if (!data) {
    // The poster holds the exact final layout, so the player swapping in causes
    // no shift (plan §8 caps CLS at 0.1).
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
        {posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl} alt="" className="h-full w-full object-cover opacity-60" />
        ) : null}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-3 border-white/30 border-t-white" />
        </div>
      </div>
    )
  }

  return (
    <AutoplayNext next={nextEpisode ?? null}>
      <VideoPlayer
        videoId={data.videoId}
        masterUrl={data.source.masterUrl}
        posterUrl={data.source.posterUrl}
        spriteVttUrl={data.source.spriteVttUrl}
        title={data.title}
        sessionId={data.sessionId}
      />
    </AutoplayNext>
  )
}

/**
 * Offers the next episode when this one ends.
 *
 * It prompts — it never navigates on its own. Silent autoplay takes the
 * decision away at the exact moment a viewer might have wanted to stop, and on
 * a metered Indian mobile connection that decision costs them money. The
 * countdown is visible, the cancel button is real, and touching the player at
 * all (playing again, scrubbing back) withdraws the offer.
 *
 * `ended` is caught in the capture phase on the wrapper rather than by wiring a
 * callback through the player: media events do not bubble, but they do
 * propagate downward, so an ancestor sees them without VideoPlayer needing to
 * know this feature exists.
 */
function AutoplayNext({
  next,
  children,
}: {
  next: NextEpisode | null
  children: React.ReactNode
}) {
  const router = useRouter()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)

  const href = next ? `/watch/${next.slug}` : null

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || !next) return

    const offer = () => setRemaining(AUTOPLAY_SECONDS)
    const withdraw = () => setRemaining(null)

    wrapper.addEventListener('ended', offer, true)
    wrapper.addEventListener('play', withdraw, true)
    wrapper.addEventListener('seeking', withdraw, true)

    return () => {
      wrapper.removeEventListener('ended', offer, true)
      wrapper.removeEventListener('play', withdraw, true)
      wrapper.removeEventListener('seeking', withdraw, true)
    }
  }, [next])

  /**
   * The prompt lives in a node this component owns, moved into the fullscreen
   * element while fullscreen is active. Anything outside that element is not
   * rendered by the browser in fullscreen — which is exactly when a countdown
   * the viewer cannot see would be at its worst.
   */
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || !next) return

    const node = document.createElement('div')
    const reparent = () => {
      const parent = (document.fullscreenElement as HTMLElement | null) ?? wrapper
      // appendChild moves an already-attached node rather than duplicating it.
      parent.appendChild(node)
    }

    reparent()
    setHost(node)
    document.addEventListener('fullscreenchange', reparent)

    return () => {
      document.removeEventListener('fullscreenchange', reparent)
      node.remove()
      setHost(null)
    }
  }, [next])

  useEffect(() => {
    if (remaining === null || !href) return

    if (remaining <= 0) {
      router.push(href)
      return
    }

    const timer = setTimeout(() => {
      setRemaining((value) => (value === null ? null : value - 1))
    }, 1000)

    return () => clearTimeout(timer)
  }, [remaining, href, router])

  const prompt =
    next && href && remaining !== null ? (
      <div
        role="region"
        aria-label="Up next"
        // The card is portalled inside the player while fullscreen, where a
        // click would otherwise reach the player's play/pause handler.
        onClick={(event) => event.stopPropagation()}
        className="absolute right-3 bottom-16 z-30 w-64 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-2xl bg-surface text-left shadow-[0_20px_50px_-15px_rgba(46,42,53,0.6)] ring-1 ring-line"
      >
        {next.thumbnailUrl ? (
          <div className="relative aspect-video w-full bg-mist">
            <Image src={next.thumbnailUrl} alt="" fill sizes="256px" className="object-cover" />
          </div>
        ) : null}

        <div className="p-3">
          <p className="text-[10px] font-extrabold tracking-wider text-muted">UP NEXT</p>
          <p className="mt-0.5 line-clamp-2 font-display text-sm leading-snug font-semibold text-ink">
            <span className="text-primary">EP {next.episodeNo}</span> {next.title}
          </p>

          <p aria-live="polite" className="mt-1.5 text-xs font-medium text-ink-soft">
            Playing in {remaining}s
          </p>
          <div aria-hidden className="mt-1 h-1 overflow-hidden rounded-full bg-mist">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
              style={{ width: `${(remaining / AUTOPLAY_SECONDS) * 100}%` }}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Link
              href={href}
              className="flex-1 rounded-full bg-primary px-3 py-1.5 text-center text-xs font-bold text-white transition hover:bg-primary/90"
            >
              Play now
            </Link>
            <button
              type="button"
              onClick={() => setRemaining(null)}
              className="rounded-full px-3 py-1.5 text-xs font-bold text-ink-soft transition hover:bg-mist"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    ) : null

  return (
    <div ref={wrapperRef} className="relative">
      {children}
      {prompt && host ? createPortal(prompt, host) : null}
    </div>
  )
}
