'use client'

import type { EventType } from '@/db/schema-analytics'

/**
 * Client-side playback telemetry.
 *
 * Events are buffered and flushed on a timer rather than sent as they happen.
 * Plan §8 asks for this explicitly, and the reason is arithmetic: a single
 * viewer generates a progress event every few seconds, so per-event requests
 * would mean roughly one HTTP round trip per second per concurrent viewer. At
 * the §13 growth scenario that is thousands of requests a second to record
 * something nobody reads until the nightly rollup.
 *
 * The buffer is also what makes the numbers honest. `videos.view_count` and the
 * trending rail read `video_stats_daily`, which is computed from this table —
 * so if nothing here fires, trending silently degrades to "newest" and every
 * view count stays at whatever it was seeded with.
 */

const FLUSH_INTERVAL_MS = 15_000
/** Above this the buffer is flushed early rather than growing without bound. */
const MAX_BUFFER = 40
const ENDPOINT = '/api/events'

export type PlaybackEvent = {
  videoId: string
  sessionId: string
  eventType: EventType
  positionSec?: number
  /** Seconds of real playback since the previous event. */
  watchedSec?: number
  variant?: string
}

let buffer: PlaybackEvent[] = []
let timer: ReturnType<typeof setInterval> | null = null

function post(events: PlaybackEvent[], useBeacon: boolean): void {
  if (events.length === 0) return

  const body = JSON.stringify({ events })

  /**
   * sendBeacon on unload. A normal fetch is cancelled when the document goes
   * away, which would drop the final — and most valuable — events of a session:
   * the ones carrying the last watched seconds and the completion.
   */
  if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
    return
  }

  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
    // Telemetry must never surface to the viewer. A dropped batch costs a row
    // in a rollup; a thrown error costs the playback session.
  }).catch(() => {})
}

export function flush(useBeacon = false): void {
  const pending = buffer
  buffer = []
  post(pending, useBeacon)
}

export function track(event: PlaybackEvent): void {
  buffer.push(event)

  if (buffer.length >= MAX_BUFFER) {
    flush()
    return
  }

  timer ??= setInterval(() => flush(), FLUSH_INTERVAL_MS)
}

/** Stop the timer and send whatever is left. Call on player teardown. */
export function stopTracking(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  flush(true)
}
