import type { ProbeResult } from './probe'
import {
  AUDIO,
  avcCodecString,
  KEYFRAME_SECONDS,
  LADDER,
  SEGMENT_SECONDS,
  type Rendition,
} from './types'

/**
 * Builds the FFmpeg invocation for one video's ABR ladder, and the master
 * playlist that describes the result.
 *
 * Three corrections to the reference command in the plan are baked in here:
 *
 *   1. Capped VBR. The plan sets -b:v alone, so libx264 overshoots on complex
 *      scenes and the declared BANDWIDTH understates the real peak. hls.js
 *      picks variants by comparing measured throughput to BANDWIDTH, so an
 *      understated value makes it choose a stream the connection cannot carry —
 *      surfacing as exactly the rebuffering plan §8 caps at 0.5%.
 *   2. One shared audio rendition instead of audio muxed into every variant.
 *   3. Forced keyframes at fixed wall-clock times, so every rendition can be
 *      switched between at any segment boundary.
 */

export type PlannedRendition = Rendition & {
  /** Actual encoded width after aspect-preserving scale, always even. */
  actualWidth: number
  actualHeight: number
}

export type EncodePlan = {
  renditions: PlannedRendition[]
  args: string[]
  gop: number
}

/**
 * Pick the rungs to encode.
 *
 * Never upscale (plan §5.3): a 480p source gets 240p/360p/480p and stops. The
 * source always gets at least one rung, so a 144p clip still produces a
 * playable stream rather than an empty ladder.
 *
 * Rungs are matched against the source's **shorter** side, not its height.
 * Height alone is right for landscape and badly wrong for portrait, which on a
 * mobile-first Indian platform is a large share of uploads. A 480x854 phone
 * video has a height of 854, so matching on height would select a "720p" rung
 * and encode 405x720 at 2800 kbps — roughly three times the bitrate those
 * 292k pixels need, paid for on every byte delivered.
 *
 * Matching on the short side gives 480x854 labelled 480p at 1400 kbps, which is
 * the same pixel count and the same bitrate as a landscape 854x480. It is also
 * how viewers and every other platform label portrait video.
 */
export function selectRenditions(source: Pick<ProbeResult, 'width' | 'height'>): PlannedRendition[] {
  const shortSide = Math.min(source.width, source.height)
  const selected = LADDER.filter((r) => r.height <= shortSide)
  const rungs = selected.length > 0 ? selected : [LADDER[0]!]

  return rungs.map((r) => {
    // Scale both axes by one factor so the aspect ratio is preserved exactly.
    // Hard-coding the ladder's nominal width would letterbox or stretch
    // anything that is not 16:9.
    const factor = r.height / shortSide

    // Round to the *nearest* even number rather than up: 16:9 at 240p is
    // 426.67, and rounding up gives 428 where every reference ladder says 426.
    const even = (n: number) => Math.max(2, Math.round((n * factor) / 2) * 2)

    return { ...r, actualWidth: even(source.width), actualHeight: even(source.height) }
  })
}

/**
 * FFmpeg arguments producing one HLS ladder plus a separate audio rendition.
 *
 * Output layout, relative to `outDir`:
 *   240p/playlist.m3u8 + init.mp4 + seg_00000.m4s …
 *   audio/playlist.m3u8 + init.mp4 + seg_00000.m4s …
 *
 * master.m3u8 is written separately by buildMasterPlaylist — FFmpeg would
 * derive BANDWIDTH from the average bitrate, and the whole point of correction
 * (1) is to advertise the peak.
 */
export function buildEncodeArgs(input: string, outDir: string, probe: ProbeResult): EncodePlan {
  const renditions = selectRenditions(probe)

  // Keyframes every KEYFRAME_SECONDS. SEGMENT_SECONDS is a multiple of it, so
  // segment boundaries always land on a keyframe.
  const gop = Math.max(1, Math.round(probe.fps * KEYFRAME_SECONDS))

  const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostdin']

  args.push('-i', input)

  // Split the decoded video once and scale each branch, rather than decoding
  // the source once per rendition.
  const splitOutputs = renditions.map((_, i) => `[v${i}]`).join('')
  const scaleChain = renditions
    .map((r, i) => `[v${i}]scale=w=${r.actualWidth}:h=${r.actualHeight}:flags=bicubic[v${i}out]`)
    .join('; ')

  args.push('-filter_complex', `[0:v]split=${renditions.length}${splitOutputs}; ${scaleChain}`)

  renditions.forEach((r, i) => {
    args.push(
      '-map', `[v${i}out]`,
      `-c:v:${i}`, 'libx264',
      `-preset:v:${i}`, 'veryfast',
      `-profile:v:${i}`, r.profile,
      `-level:v:${i}`, r.level,
      `-pix_fmt:v:${i}`, 'yuv420p',
      `-b:v:${i}`, `${r.bitrateKbps}k`,
      // Correction (1): cap the peak and size the buffer, so the encoder cannot
      // exceed what the master playlist advertises.
      `-maxrate:v:${i}`, `${r.peakBitrateKbps}k`,
      `-bufsize:v:${i}`, `${Math.round(r.peakBitrateKbps * 1.5)}k`,
      `-g:v:${i}`, String(gop),
      `-keyint_min:v:${i}`, String(gop),
      // Correction (3): scene-cut keyframes would land at different timestamps
      // in each rendition and break switching, so they are disabled and
      // keyframes are forced onto a fixed clock instead.
      `-sc_threshold:v:${i}`, '0',
    )
  })

  args.push('-force_key_frames', `expr:gte(t,n_forced*${KEYFRAME_SECONDS})`)

  // Correction (2): exactly one audio stream, shared by every variant.
  if (probe.hasAudio) {
    args.push(
      '-map', 'a:0',
      '-c:a', 'aac',
      '-b:a', `${AUDIO.bitrateKbps}k`,
      '-ac', String(AUDIO.channels),
      '-ar', String(AUDIO.sampleRate),
    )
  }

  // `name:` sets what %v expands to, so output lands in 240p/, 720p/, audio/
  // rather than 0/, 1/, 2/. Those directory names end up in the master playlist
  // and therefore in CDN cache keys, so they should be readable and stable.
  const videoMap = renditions.map((r, i) => `v:${i},agroup:${AUDIO.groupId},name:${r.name}`)
  const varStreamMap = probe.hasAudio
    ? [...videoMap, `a:0,agroup:${AUDIO.groupId},name:${AUDIO.name},default:yes`].join(' ')
    : videoMap.join(' ')

  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    // Guarantees each segment can be decoded without the one before it, which
    // is what lets a player switch variants mid-stream.
    '-hls_flags', 'independent_segments',
    '-hls_list_size', '0',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', `${outDir}/%v/seg_%05d.m4s`,
    '-var_stream_map', varStreamMap,
    `${outDir}/%v/playlist.m3u8`,
  )

  return { renditions, args, gop }
}

/** Directories FFmpeg will write into. It does not create them itself. */
export function variantDirNames(renditions: PlannedRendition[], hasAudio: boolean): string[] {
  const names = renditions.map((r) => r.name)
  return hasAudio ? [...names, AUDIO.name] : names
}

/**
 * The master playlist.
 *
 * BANDWIDTH is the peak (video cap + audio), AVERAGE-BANDWIDTH the target.
 * Advertising the peak is what stops a player from over-selecting on a
 * connection that cannot sustain the rung's worst moments.
 */
export function buildMasterPlaylist(
  renditions: PlannedRendition[],
  opts: { hasAudio: boolean } = { hasAudio: true },
): string {
  const lines = [
    '#EXTM3U',
    // Version 7 is the minimum for fMP4/CMAF segments.
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '',
  ]

  if (opts.hasAudio) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO.groupId}",NAME="Audio",` +
        `DEFAULT=YES,AUTOSELECT=YES,CHANNELS="${AUDIO.channels}",URI="${AUDIO.name}/playlist.m3u8"`,
      '',
    )
  }

  // Ascending bitrate. hls.js starts at the first variant unless told
  // otherwise, and plan §8 wants playback to open around 480p and climb — the
  // player is configured with an explicit startLevel rather than relying on
  // ordering.
  for (const r of [...renditions].sort((a, b) => a.bitrateKbps - b.bitrateKbps)) {
    const audioKbps = opts.hasAudio ? AUDIO.bitrateKbps : 0
    const peak = (r.peakBitrateKbps + audioKbps) * 1000
    const average = (r.bitrateKbps + audioKbps) * 1000
    const codecs = opts.hasAudio
      ? `${avcCodecString(r)},${AUDIO.codec}`
      : avcCodecString(r)

    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${peak},AVERAGE-BANDWIDTH=${average},` +
        `RESOLUTION=${r.actualWidth}x${r.actualHeight},CODECS="${codecs}"` +
        (opts.hasAudio ? `,AUDIO="${AUDIO.groupId}"` : ''),
      `${r.name}/playlist.m3u8`,
    )
  }

  return lines.join('\n') + '\n'
}
