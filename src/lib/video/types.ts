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
  /** H.264 profile. Older Android devices are safest on main below 480p. */
  profile: 'main' | 'high'
  /** H.264 level, as "3.0". Pairs with profile to form the CODECS attribute. */
  level: string
}

/**
 * One shared audio rendition, referenced by every video variant through an
 * HLS audio group.
 *
 * Plan §5.3 gives each rung its own audio bitrate, which only makes sense when
 * audio is muxed into every variant — as the plan's reference FFmpeg command
 * does by mapping `a:0` three times. That triples audio storage and, worse,
 * makes multi-audio-track support (a v2 feature) impossible to add later
 * without re-encoding the entire library.
 *
 * A separate audio group stores audio once, and gives the audio-only rendition
 * for very poor connections that plan §5.4 asks for at no extra cost.
 */
export const AUDIO = {
  name: 'audio',
  groupId: 'aud',
  bitrateKbps: 128,
  channels: 2,
  sampleRate: 48000,
  /** AAC-LC. */
  codec: 'mp4a.40.2',
} as const

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
  { name: '240p', width: 426, height: 240, bitrateKbps: 400, peakBitrateKbps: 428, profile: 'main', level: '3.0' },
  { name: '360p', width: 640, height: 360, bitrateKbps: 800, peakBitrateKbps: 856, profile: 'main', level: '3.0' },
  { name: '480p', width: 854, height: 480, bitrateKbps: 1400, peakBitrateKbps: 1498, profile: 'high', level: '3.1' },
  { name: '720p', width: 1280, height: 720, bitrateKbps: 2800, peakBitrateKbps: 2996, profile: 'high', level: '3.1' },
  { name: '1080p', width: 1920, height: 1080, bitrateKbps: 5000, peakBitrateKbps: 5350, profile: 'high', level: '4.0' },
] as const

/**
 * CODECS attribute values, as profile_idc/constraints/level_idc hex.
 * Getting these wrong makes Safari refuse a stream outright rather than
 * degrade, so they are a lookup table instead of something computed.
 */
export const AVC_CODEC: Record<string, string> = {
  'main@3.0': 'avc1.4d401e',
  'main@3.1': 'avc1.4d401f',
  'high@3.1': 'avc1.64001f',
  'high@4.0': 'avc1.640028',
  'high@4.1': 'avc1.640029',
}

export function avcCodecString(r: Rendition): string {
  return AVC_CODEC[`${r.profile}@${r.level}`] ?? 'avc1.4d401e'
}

/** HLS segment duration. Longer segments = fewer R2 Class B reads (plan §0). */
export const SEGMENT_SECONDS = 6

/**
 * Keyframe interval, in seconds.
 *
 * Every rendition must place keyframes at identical timestamps. If they drift,
 * the player cannot switch variants at a segment boundary and quality changes
 * stutter or stall. SEGMENT_SECONDS must be an exact multiple of this.
 */
export const KEYFRAME_SECONDS = 2

export type UploadTicket = {
  /** Where the client PUTs/POSTs bytes. Never proxied through this app. */
  url: string
  method: 'PUT' | 'POST'
  headers?: Record<string, string>
  /** Provider-side identifier to persist on the video row. */
  assetId: string
  expiresAt: Date
}

/**
 * Resumable upload.
 *
 * Plan §5.1 specifies TUS, which Bunny speaks natively and R2 does not. Rather
 * than pretend one protocol covers both, the provider returns a plan the client
 * branches on. The property that actually matters — a creator on a dropping
 * mobile connection never restarts a 2 GB upload from zero — holds either way.
 */
export type ResumableUploadPlan =
  | {
      protocol: 'multipart'
      objectKey: string
      multipartId: string
      partSizeBytes: number
      totalParts: number
    }
  | {
      protocol: 'tus'
      endpoint: string
      headers: Record<string, string>
      assetId: string
    }

export type UploadedPart = {
  partNumber: number
  etag: string
  sizeBytes: number
}

/**
 * S3 requires every part but the last to be identically sized, minimum 5 MB,
 * maximum 10,000 parts.
 *
 * 8 MB is chosen for the audience rather than for throughput: on a connection
 * that drops every few minutes, a failed part costs at most 8 MB of re-upload.
 * Larger parts would finish faster on a good link and waste far more on a bad
 * one, and bad links are the design target here.
 */
export const MIN_PART_SIZE = 8 * 1024 * 1024
export const MAX_PARTS = 10_000

export function planPartSize(totalBytes: number): { partSizeBytes: number; totalParts: number } {
  const megabyte = 1024 * 1024
  // Grow the part size only as far as needed to stay under the part limit.
  const required = Math.ceil(totalBytes / MAX_PARTS)
  const partSizeBytes = Math.max(MIN_PART_SIZE, Math.ceil(required / megabyte) * megabyte)

  return { partSizeBytes, totalParts: Math.max(1, Math.ceil(totalBytes / partSizeBytes)) }
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
  readonly id: 'r2' | 'bunny' | 'local'

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

  // --- Resumable upload ----------------------------------------------------

  createResumableUpload(input: {
    videoId: string
    filename: string
    contentType: string
    sizeBytes: number
  }): Promise<ResumableUploadPlan>

  /**
   * Presigned URL for one part. Multipart providers only — TUS resumes by
   * asking the upload URL how many bytes it already holds, with no server
   * involvement.
   */
  signUploadPart(input: {
    objectKey: string
    multipartId: string
    partNumber: number
  }): Promise<string>

  /** Which parts already landed. This is what makes a resume possible. */
  listUploadedParts(input: { objectKey: string; multipartId: string }): Promise<UploadedPart[]>

  completeResumableUpload(input: {
    objectKey: string
    multipartId: string
    parts: UploadedPart[]
  }): Promise<void>

  abortResumableUpload(input: { objectKey: string; multipartId: string }): Promise<void>

  // --- Worker-side transfer ------------------------------------------------

  /** Stream an object to local disk for transcoding. */
  downloadToFile(objectKey: string, localPath: string): Promise<void>

  /** Upload a local directory tree under a key prefix. */
  uploadDirectory(input: {
    localDir: string
    keyPrefix: string
    onProgress?: (done: number, total: number) => void
  }): Promise<number>

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
