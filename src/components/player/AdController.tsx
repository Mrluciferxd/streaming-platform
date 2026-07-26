'use client'

import { useEffect, useRef, useState } from 'react'

import { preRoll } from '@/lib/ads/config'
import { preRollDecision, recordPreRoll } from '@/lib/ads/frequency'
import { createPreRollSession } from '@/lib/ads/preroll'
import { trackAdComplete, trackAdImpression } from '@/lib/ads/telemetry'

/**
 * Pre-roll overlay for the watch player.
 *
 * Everything ad-related lives behind this component and `src/lib/ads`, so the
 * player itself gains one element and no branches. It hooks in by listening to
 * the content element rather than by wrapping the play control: the moment a
 * viewer starts a video is a `play` event whether it came from the button, the
 * keyboard, a tap on the frame, or picture-in-picture, and intercepting the
 * event catches all of them without the player having to know an ad exists.
 *
 * When ads are unconfigured this renders `null` and registers nothing.
 */

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** The player box. Gestures are watched here, and the overlay fills it. */
  containerRef: React.RefObject<HTMLDivElement | null>
  videoId: string
  sessionId?: string
}

export function AdController({ videoRef, containerRef, videoId, sessionId }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)

  const [active, setActive] = useState(false)
  const [rendering, setRendering] = useState(false)

  useEffect(() => {
    if (!preRoll) return

    const video = videoRef.current
    const container = containerRef.current
    const overlay = overlayRef.current
    if (!video || !container || !overlay) return

    // Frequency cap first, so a capped viewer costs no SDK download and no ad
    // request — the cheapest impression is the one never asked for.
    if (!preRollDecision(videoId, preRoll).show) return

    const session = createPreRollSession({
      adContainer: overlay,
      video,
      tagUrl: preRoll.tagUrl,
      onBreakStart: () => {
        setActive(true)
        setRendering(false)
      },
      onAdStarted: () => {
        setRendering(true)
        recordPreRoll(videoId)
        trackAdImpression({ videoId, sessionId })
      },
      onBreakEnd: (outcome) => {
        setActive(false)
        setRendering(false)
        // Only a creative that ran to its end is a completion. A skip is a
        // billable impression but not a completed view, and conflating them
        // makes the completion rate in the rollup meaningless.
        if (outcome === 'complete') trackAdComplete({ videoId, sessionId })
      },
    })

    /**
     * IMA can only unlock an ad video element for sound from inside a real user
     * gesture, and the `play` event that starts the break is one tick too late
     * to count as one. Capturing the gesture that precedes it gives IMA its
     * window; without this the ad is silent on iOS.
     */
    const prime = () => session.primeForGesture()
    container.addEventListener('pointerdown', prime, { capture: true })
    container.addEventListener('keydown', prime, { capture: true })

    let consumed = false
    const onPlay = () => {
      if (consumed) return
      /**
       * The first play is the only one that can carry a pre-roll, whatever the
       * answer. Leaving the door open until an ad is available would mean a
       * request that resolved late fires an ad when the viewer resumes from a
       * pause twenty minutes in — a pre-roll arriving as a mid-roll.
       */
      consumed = true
      // `tryStart` answers about this instant only. Not ready means the request
      // is still in flight, was blocked, or came back empty — all of which
      // resolve to the viewer getting their video immediately.
      session.tryStart()
    }

    const onVolumeChange = () => session.syncVolume()
    const onResize = () => session.resize()

    video.addEventListener('play', onPlay)
    video.addEventListener('volumechange', onVolumeChange)
    window.addEventListener('resize', onResize, { passive: true })
    document.addEventListener('fullscreenchange', onResize)

    return () => {
      container.removeEventListener('pointerdown', prime, { capture: true })
      container.removeEventListener('keydown', prime, { capture: true })
      video.removeEventListener('play', onPlay)
      video.removeEventListener('volumechange', onVolumeChange)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('fullscreenchange', onResize)

      session.destroy()
    }
  }, [videoId, sessionId, videoRef, containerRef])

  if (!preRoll) return null

  return (
    <div
      // Kept in the layout rather than unmounted: IMA measures this element
      // when the ad is requested, and a display:none container reports a zero
      // box, which renders a zero-sized creative.
      className={`absolute inset-0 z-50 ${
        active ? 'visible pointer-events-auto' : 'invisible pointer-events-none'
      }`}
      // The player toggles playback on a click anywhere in its box and seeks on
      // a double tap. Neither should reach it through an ad.
      onClick={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      <div ref={overlayRef} className="h-full w-full" />

      {active && !rendering ? (
        // The hand-off window only. Once IMA paints, its own countdown and "Ad"
        // attribution own the frame and a second label would just be clutter.
        // Bounded by the watchdog in preroll.ts, so this cannot outstay it.
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white" />
          <span className="text-xs font-medium tracking-wide text-white/70">Advertisement</span>
        </div>
      ) : null}
    </div>
  )
}
