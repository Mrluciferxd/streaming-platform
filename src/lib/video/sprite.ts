import type { ProbeResult } from './probe'

/**
 * Poster, scrub-bar sprite sheet, and hover preview (plan §5.5).
 *
 * The sprite sheet is the one that makes a site feel finished: a single image
 * of every Nth frame plus a WebVTT index, so dragging the scrub bar shows
 * frames instantly with no extra network requests. One image is also far
 * cheaper than N thumbnails at R2's per-object read pricing.
 */

export const SPRITE_COLUMNS = 10
export const SPRITE_THUMB_WIDTH = 160
/** Cap on tiles, so a three-hour film does not produce a 40 MB sheet. */
export const SPRITE_MAX_TILES = 120

export type SpritePlan = {
  intervalSec: number
  columns: number
  rows: number
  tileWidth: number
  tileHeight: number
  count: number
}

export function planSprite(probe: ProbeResult): SpritePlan {
  // One tile per second for short clips, stretching out for long ones so the
  // sheet never exceeds SPRITE_MAX_TILES.
  const intervalSec = Math.max(1, Math.ceil(probe.durationSec / SPRITE_MAX_TILES))
  const count = Math.max(1, Math.floor(probe.durationSec / intervalSec) + 1)

  // Preserve the source aspect ratio; height rounded to the nearest even value
  // because the encoder requires even dimensions.
  const rawHeight = (probe.height * SPRITE_THUMB_WIDTH) / probe.width
  const tileHeight = Math.max(2, Math.round(rawHeight / 2) * 2)

  return {
    intervalSec,
    columns: SPRITE_COLUMNS,
    rows: Math.ceil(count / SPRITE_COLUMNS),
    tileWidth: SPRITE_THUMB_WIDTH,
    tileHeight,
    count,
  }
}

export function buildSpriteArgs(input: string, outPath: string, plan: SpritePlan): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', input,
    '-vf',
    `fps=1/${plan.intervalSec},scale=${plan.tileWidth}:${plan.tileHeight}:flags=bicubic,` +
      `tile=${plan.columns}x${plan.rows}`,
    '-frames:v', '1',
    '-q:v', '4',
    '-y', outPath,
  ]
}

/** Poster frame at 10% of duration — past the titles, into actual content. */
export function buildPosterArgs(input: string, outPath: string, probe: ProbeResult): string[] {
  const at = Math.max(0, probe.durationSec * 0.1)

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // -ss before -i seeks by keyframe, which is near-instant even on a long
    // file. Accuracy does not matter for a poster frame.
    '-ss', at.toFixed(3),
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=1280:-2:flags=bicubic',
    '-q:v', '3',
    '-y', outPath,
  ]
}

/** Silent animated WebP for card hover (plan §5.5). */
export function buildPreviewArgs(input: string, outPath: string, probe: ProbeResult): string[] {
  const at = Math.max(0, probe.durationSec * 0.25)

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', at.toFixed(3),
    '-t', '3',
    '-i', input,
    '-vf', 'fps=12,scale=480:-2:flags=bicubic',
    '-loop', '0',
    '-an',
    '-quality', '60',
    '-y', outPath,
  ]
}

function timestamp(totalSeconds: number): string {
  const ms = Math.round((totalSeconds % 1) * 1000)
  const s = Math.floor(totalSeconds) % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)

  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  )
}

/**
 * WebVTT index mapping each time range to a region of the sprite sheet, using
 * the media-fragment `#xywh=` syntax every major player understands.
 *
 * `spriteUrl` is written relative (just "sprite.jpg") so the file stays valid
 * whichever domain serves it — the VTT and the sheet always sit side by side.
 */
export function buildSpriteVtt(
  plan: SpritePlan,
  probe: ProbeResult,
  spriteUrl = 'sprite.jpg',
): string {
  const cues: string[] = ['WEBVTT', '']

  for (let i = 0; i < plan.count; i++) {
    const start = i * plan.intervalSec
    if (start >= probe.durationSec) break

    const end = Math.min((i + 1) * plan.intervalSec, probe.durationSec)
    const x = (i % plan.columns) * plan.tileWidth
    const y = Math.floor(i / plan.columns) * plan.tileHeight

    cues.push(
      `${timestamp(start)} --> ${timestamp(end)}`,
      `${spriteUrl}#xywh=${x},${y},${plan.tileWidth},${plan.tileHeight}`,
      '',
    )
  }

  return cues.join('\n')
}
