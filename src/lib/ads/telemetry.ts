'use client'

import { track } from '@/lib/player/analytics'

/**
 * Ad telemetry, sent down the existing playback batcher.
 *
 * `video_events` already carries `ad_impression` and `ad_complete`, and
 * `rollup_video_stats` already counts the first into
 * `video_stats_daily.ad_impressions`. Nothing new is needed server-side — an
 * ad event is a playback event with a different `event_type`, and routing it
 * through the same 15-second buffer means it costs no extra request.
 *
 * `watchedSec` is deliberately never set. The rollup sums `watched_sec` across
 * every event type into `watch_seconds`, and `watch_seconds` is what creator
 * revenue share is computed from — crediting a creator with the seconds their
 * viewers spent watching an ad would quietly overstate every payout.
 */

/** `video_events.variant` is varchar(12); this is what separates ad formats later. */
const FORMAT_PREROLL = 'preroll'

export type AdTelemetryContext = {
  videoId: string
  /** Absent for viewers whose playback session could not be established. */
  sessionId?: string
}

export function trackAdImpression({ videoId, sessionId }: AdTelemetryContext): void {
  if (!sessionId) return

  track({
    videoId,
    sessionId,
    eventType: 'ad_impression',
    // A pre-roll is at position zero by definition. Mid-roll (plan §7 v2) will
    // pass the real content offset here, which is what makes break-level
    // completion rates readable from the same table.
    positionSec: 0,
    variant: FORMAT_PREROLL,
  })
}

export function trackAdComplete({ videoId, sessionId }: AdTelemetryContext): void {
  if (!sessionId) return

  track({
    videoId,
    sessionId,
    eventType: 'ad_complete',
    positionSec: 0,
    variant: FORMAT_PREROLL,
  })
}
