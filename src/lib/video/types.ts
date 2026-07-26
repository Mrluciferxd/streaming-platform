/**
 * The seam between the application and whoever is storing/serving the video.
 *
 * Plan §2 recommends starting on a managed provider and migrating to R2 once
 * egress crosses ~20 TB/month. That migration is only cheap if nothing outside
 * this directory ever learns which provider is live. Rules:
 *
 *   - No route, component, or query may import from ./r2 or ./bunny directly.
 *     Import `videoProvider` from ./index.
 *   - No provider-shaped URLs in the database. `videos.hls_master_path` stores
 *     a bucket-relative path; the provider turns it into a URL at read time.
 *   - Anything a provider cannot do for every implementation does not belong
 *     on this interface.
 */

export type Rendition = {
  name: string // "720p"
  width: number
  height: number
  /** Target average bitrate. */
  bitrateKbps: number
  /** Capped-VBR ceiling. Goes into the playlist's BANDWIDTH attribute. */
  peakBitrateKbps: number
  audioKbps: number
}

/**
 * The ABR ladder from plan §5.3, with peak bitrates added.
 *
 * The plan's reference FFmpeg command sets -b:v with no -maxrate/-bufsize, so
 * libx264 overshoots on complex scenes and the real peak lands well above the
 * declared average. hls.js picks renditions by comparing measured throughput
 * against the playlist's BANDWIDTH attribute, so an understated BANDWIDTH makes
 * it choose a stream the connection cannot sustain — which shows up as the
 * rebuffering that plan §8 wants held under 0.5%.
 *
 * Fix: encode capped VBR (maxrate ≈ 1.07x, bufsize ≈ 1.5x) and advertise the
 * cap. Never upscale — the pipeline filters this list against source height.
 */
export const LADDER: readonly Rendition[] = [
  { name: '240p', width: 426, height: 240, bitrateKbps: 400, peakBitrateKbps: 428, audioKbps: 64 },
  { name: '360p', width: 640, height: 360, bitrateKbps: 800, peakBitrateKbps: 856, audioKbps: 96 },
  { name: '480p', width: 854, height: 480, bitrateKbps: 1400, peakBitrateKbps: 1498, audioKbps: 128 },
  { name: '720p', width: 1280, height: 720, bitrateKbps: 2800, peakBitrateKbps: 2996, audioKbps: 128 },
  { name: '1080p', width: 1920, height: 1080, bitrateKbps: 5000, peakBitrateKbps: 5350, audioKbps: 192 },
] as const

/** HLS segment duration. Longer segments = fewer R2 Class B reads (plan §0). */
export const SEGMENT_SECONDS = 6

export type UploadTicket = {
  /** Where the client PUTs/POSTs bytes. Never proxied through this app. */
  url: string
  method: 'PUT' | 'POST'
  headers?: Record<string, string>
  /** Provider-side identifier to persist on the video row. */
  assetId: string
  expiresAt: Date
}

export type PlaybackSource = {
  /** Absolute URL of the HLS master playlist, signed if the provider needs it. */
  masterUrl: string
  /** Poster frame, sprite sheet and its WebVTT index — all CDN-absolute. */
  posterUrl: string | null
  spriteUrl: string | null
  spriteVttUrl: string | null
}

export interface VideoProvider {
  readonly id: 'r2' | 'bunny'

  /**
   * Mint a direct-to-storage upload ticket. Bytes must never transit the
   * application server (plan §5.1) — a ₹2,000 VPS cannot absorb 2 GB uploads.
   */
  createUploadTicket(input: {
    videoId: string
    filename: string
    contentType: string
    sizeBytes: number
  }): Promise<UploadTicket>

  /**
   * Resolve everything the player needs for one video.
   *
   * `sessionId` is threaded through for token binding. Implementations MUST NOT
   * mint per-session segment URLs — see ./token.ts.
   */
  getPlaybackSource(input: {
    videoId: string
    hlsMasterPath: string | null
    posterPath: string | null
    spritePath: string | null
    spriteVttPath: string | null
    sessionId?: string
    ip?: string
  }): Promise<PlaybackSource>

  /** Absolute CDN URL for a non-video asset (poster, sprite, avatar). */
  publicUrl(path: string): string

  /** Store a generated artifact: playlists, sprites, VTT. Small files only. */
  putObject(input: {
    path: string
    body: Uint8Array | string
    contentType: string
    cacheControl?: string
  }): Promise<void>

  /** Remove every object under a prefix. Used on takedown and failed uploads. */
  deletePrefix(prefix: string): Promise<void>
}

/** Canonical object layout. Keep it stable — these paths end up in the CDN cache. */
export const paths = {
  source: (videoId: string, ext: string) => `source/${videoId}/original.${ext}`,
  master: (videoId: string) => `v/${videoId}/master.m3u8`,
  variantPlaylist: (videoId: string, rendition: string) => `v/${videoId}/${rendition}/playlist.m3u8`,
  segment: (videoId: string, rendition: string, n: number) =>
    `v/${videoId}/${rendition}/seg_${String(n).padStart(5, '0')}.m4s`,
  poster: (videoId: string) => `v/${videoId}/poster.jpg`,
  sprite: (videoId: string) => `v/${videoId}/sprite.jpg`,
  spriteVtt: (videoId: string) => `v/${videoId}/sprite.vtt`,
  preview: (videoId: string) => `v/${videoId}/preview.webp`,
  subtitle: (videoId: string, lang: string) => `v/${videoId}/subs/${lang}.vtt`,
  prefix: (videoId: string) => `v/${videoId}/`,
} as const
