'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { findCue, parseThumbnailVtt, type ThumbnailCue } from '@/lib/player/thumbnails'
import { formatTime } from './formatTime'

/**
 * Scrub bar with sprite-sheet thumbnail previews (plan §7).
 *
 * Previews cost no network requests while scrubbing: the whole filmstrip is one
 * already-cached image, and each cue is a background-position offset into it.
 */

type Props = {
  currentTime: number
  duration: number
  bufferedEnd: number
  spriteVttUrl: string | null
  onSeek: (time: number) => void
}

export function SeekBar({ currentTime, duration, bufferedEnd, spriteVttUrl, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [cues, setCues] = useState<ThumbnailCue[]>([])
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!spriteVttUrl) return
    let cancelled = false

    fetch(spriteVttUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (!cancelled) setCues(parseThumbnailVtt(text, spriteVttUrl))
      })
      // Previews are a nicety; a missing sheet must not break seeking.
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [spriteVttUrl])

  const timeAt = useCallback(
    (clientX: number): number => {
      const track = trackRef.current
      if (!track || duration <= 0) return 0

      const rect = track.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return ratio * duration
    },
    [duration],
  )

  // Pointer events are captured on the window during a drag so the scrub
  // continues when the pointer leaves the bar — the normal way people scrub.
  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent) => {
      const time = timeAt(event.clientX)
      setHoverTime(time)
      onSeek(time)
    }
    const onUp = () => {
      setDragging(false)
      setHoverTime(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, onSeek, timeAt])

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const buffered = duration > 0 ? (bufferedEnd / duration) * 100 : 0
  const previewTime = hoverTime ?? 0
  const cue = hoverTime !== null && cues.length > 0 ? findCue(cues, previewTime) : null
  const previewRatio = duration > 0 ? Math.max(0, Math.min(1, previewTime / duration)) : 0

  return (
    <div className="relative w-full">
      {hoverTime !== null ? (
        <div
          className="pointer-events-none absolute bottom-6 z-10 -translate-x-1/2 flex flex-col items-center gap-1"
          style={{ left: `${previewRatio * 100}%` }}
        >
          {cue ? (
            <div
              className="rounded border-2 border-white/80 bg-black shadow-lg"
              style={{
                width: cue.width,
                height: cue.height,
                backgroundImage: `url(${cue.url})`,
                backgroundPosition: `-${cue.x}px -${cue.y}px`,
                backgroundRepeat: 'no-repeat',
              }}
            />
          ) : null}
          <span className="rounded bg-black/85 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white">
            {formatTime(previewTime)}
          </span>
        </div>
      ) : null}

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration) || 0}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
        // Generous vertical padding gives a touch-friendly target while the
        // visible bar stays thin.
        className="group relative cursor-pointer py-2 touch-none"
        onPointerDown={(event) => {
          event.preventDefault()
          setDragging(true)
          const time = timeAt(event.clientX)
          setHoverTime(time)
          onSeek(time)
        }}
        onPointerMove={(event) => {
          if (!dragging) setHoverTime(timeAt(event.clientX))
        }}
        onPointerLeave={() => {
          if (!dragging) setHoverTime(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onSeek(Math.max(0, currentTime - 5))
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            onSeek(Math.min(duration, currentTime + 5))
          }
        }}
      >
        <div className="relative h-1 w-full rounded-full bg-white/25 transition-[height] group-hover:h-1.5">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/40"
            style={{ width: `${buffered}%` }}
          />
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-red-600"
            style={{ width: `${progress}%` }}
          />
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-600 opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: `${progress}%`, opacity: dragging ? 1 : undefined }}
          />
        </div>
      </div>
    </div>
  )
}
