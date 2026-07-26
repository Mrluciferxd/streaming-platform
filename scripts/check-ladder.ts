/**
 * Ladder selection cases that are easy to get wrong and expensive to get wrong.
 *
 *   npx tsx scripts/check-ladder.ts
 */
import { selectRenditions } from '../src/lib/video/encode.ts'

let failures = 0

function check(ok: boolean, label: string, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

function describe(width: number, height: number) {
  const rungs = selectRenditions({ width, height })
  return {
    rungs,
    names: rungs.map((r) => r.name),
    sizes: rungs.map((r) => `${r.actualWidth}x${r.actualHeight}`),
  }
}

// --- Landscape --------------------------------------------------------------
{
  const { names, sizes } = describe(1920, 1080)
  check(names.join(',') === '240p,360p,480p,720p,1080p', '1080p source gets the full ladder', names.join(','))
  check(sizes.includes('426x240') && sizes.includes('1920x1080'), '1080p source dimensions', sizes.join(' '))
}
{
  const { names } = describe(1280, 720)
  check(!names.includes('1080p'), '720p source is never upscaled to 1080p', names.join(','))
}
{
  const { names, sizes } = describe(640, 360)
  check(names.join(',') === '240p,360p', '360p source stops at 360p', `${names.join(',')} → ${sizes.join(' ')}`)
}

// --- Portrait ---------------------------------------------------------------
{
  const { names, sizes, rungs } = describe(480, 854)
  check(names.join(',') === '240p,360p,480p', 'portrait 480x854 matched on short side', names.join(','))
  check(sizes.includes('480x854'), 'portrait top rung keeps native size', sizes.join(' '))

  // The bitrate check is the point of the short-side rule: 480x854 and 854x480
  // have the same pixel count and must get the same bitrate.
  const top = rungs.at(-1)!
  check(top.bitrateKbps === 1400, 'portrait top rung uses 480p bitrate, not 720p', `${top.bitrateKbps} kbps`)
}
{
  const { sizes } = describe(1080, 1920)
  check(sizes.at(-1) === '1080x1920', 'full-HD portrait tops out at native', sizes.join(' '))
}

// --- Square and odd shapes --------------------------------------------------
{
  const { names, sizes } = describe(720, 720)
  check(names.at(-1) === '720p', 'square 720x720 tops out at 720p', names.join(','))
  check(sizes.at(-1) === '720x720', 'square stays square', sizes.join(' '))
}
{
  const { sizes } = describe(1920, 800) // 2.40:1 cinemascope
  check(
    sizes.every((s) => s.split('x').every((n) => Number(n) % 2 === 0)),
    'cinemascope dimensions all even',
    sizes.join(' '),
  )
}

// --- Degenerate -------------------------------------------------------------
{
  const { names } = describe(320, 180)
  check(names.length === 1 && names[0] === '240p', 'sub-240p source still gets one playable rung', names.join(','))
}

// --- Universal invariants ---------------------------------------------------
for (const [w, h] of [[1920, 1080], [480, 854], [720, 720], [1920, 800], [640, 360], [1080, 1920]]) {
  const { rungs } = describe(w!, h!)

  check(
    rungs.every((r) => r.actualWidth % 2 === 0 && r.actualHeight % 2 === 0),
    `${w}x${h}: all dimensions even (libx264 requires it)`,
  )
  check(
    rungs.every((r) => r.actualWidth <= w! && r.actualHeight <= h!),
    `${w}x${h}: never upscales either axis`,
  )
  check(
    rungs.every((r) => Math.abs(r.actualWidth / r.actualHeight - w! / h!) < 0.02),
    `${w}x${h}: aspect ratio preserved`,
  )
  check(
    rungs.every((r) => r.peakBitrateKbps > r.bitrateKbps),
    `${w}x${h}: peak exceeds target (capped VBR is configured)`,
  )
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
