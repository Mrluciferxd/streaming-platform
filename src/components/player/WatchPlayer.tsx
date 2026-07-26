'use client'

import { useEffect, useState } from 'react'

import { VideoPlayer } from './VideoPlayer'

type PlaybackResponse = {
  videoId: string
  title: string
  source: {
    masterUrl: string
    posterUrl: string | null
    spriteUrl: string | null
    spriteVttUrl: string | null
  }
}

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
export function WatchPlayer({ slug, posterUrl }: { slug: string; posterUrl: string | null }) {
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
    <VideoPlayer
      videoId={data.videoId}
      masterUrl={data.source.masterUrl}
      posterUrl={data.source.posterUrl}
      spriteVttUrl={data.source.spriteVttUrl}
      title={data.title}
    />
  )
}
