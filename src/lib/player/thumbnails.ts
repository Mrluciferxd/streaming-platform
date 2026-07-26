/**
 * Parses the sprite WebVTT produced by the transcode pipeline into cues the
 * scrub bar can render (plan §7: scrub-bar thumbnail previews).
 *
 * Each cue points at a rectangle of one sprite sheet via a `#xywh=` media
 * fragment, so hovering the seek bar costs no network requests at all — the
 * sheet is a single image already in cache.
 */

export type ThumbnailCue = {
  start: number
  end: number
  url: string
  x: number
  y: number
  width: number
  height: number
}

/** "00:01:23.456" or "01:23.456" → seconds. */
function parseTimestamp(value: string): number {
  const parts = value.trim().split(':').map(Number)
  if (parts.some(Number.isNaN)) return Number.NaN

  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  return parts[0] ?? Number.NaN
}

export function parseThumbnailVtt(vtt: string, baseUrl: string): ThumbnailCue[] {
  const cues: ThumbnailCue[] = []
  // Blank-line separated blocks; \r\n tolerated because WebVTT permits it.
  const blocks = vtt.replace(/\r\n/g, '\n').split(/\n{2,}/)

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const arrowIndex = lines.findIndex((l) => l.includes('-->'))
    if (arrowIndex === -1) continue

    const [rawStart, rawEnd] = lines[arrowIndex]!.split('-->')
    const payload = lines[arrowIndex + 1]
    if (!rawStart || !rawEnd || !payload) continue

    const start = parseTimestamp(rawStart)
    const end = parseTimestamp(rawEnd)
    if (Number.isNaN(start) || Number.isNaN(end)) continue

    const [rawUrl, fragment] = payload.trim().split('#xywh=')
    if (!rawUrl || !fragment) continue

    const [x, y, width, height] = fragment.split(',').map(Number)
    if ([x, y, width, height].some((n) => n === undefined || Number.isNaN(n))) continue

    cues.push({
      start,
      end,
      // The VTT stores a relative filename so the file is valid on whichever
      // host serves it; resolve against the sheet's own URL.
      url: new URL(rawUrl, baseUrl).href,
      x: x!,
      y: y!,
      width: width!,
      height: height!,
    })
  }

  return cues
}

/**
 * Cue covering `time`. Binary search — a three-hour film has ~120 cues and this
 * runs on every pointer move along the scrub bar.
 */
export function findCue(cues: ThumbnailCue[], time: number): ThumbnailCue | null {
  let low = 0
  let high = cues.length - 1

  while (low <= high) {
    const mid = (low + high) >> 1
    const cue = cues[mid]!

    if (time < cue.start) high = mid - 1
    else if (time >= cue.end) low = mid + 1
    else return cue
  }

  // Past the last cue (a seek to the very end) — clamp rather than show nothing.
  return cues.at(-1) ?? null
}
