import { env } from '@/lib/env'
import type { VideoProvider } from './types'

/**
 * The only place the app is allowed to learn which video backend is live.
 *
 * Providers are imported lazily so that running with VIDEO_PROVIDER=bunny does
 * not require R2 credentials to be present, and vice versa.
 */
let cached: VideoProvider | null = null

export async function getVideoProvider(): Promise<VideoProvider> {
  if (cached) return cached

  cached =
    env.VIDEO_PROVIDER === 'bunny'
      ? (await import('./bunny')).bunnyProvider
      : (await import('./r2')).r2Provider

  return cached
}

export { LADDER, SEGMENT_SECONDS, paths } from './types'
export type { PlaybackSource, Rendition, UploadTicket, VideoProvider } from './types'
export { issuePlaybackToken, verifyPlaybackToken, PLAYBACK_COOKIE, playbackCookieOptions } from './token'
