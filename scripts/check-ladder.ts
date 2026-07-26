/**
 * Ladder selection cases that are easy to get wrong and expensive to get wrong.
 *
 *   npm run check:ladder
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { selectRenditions } from '../src/lib/video/encode.ts'

function ladder(width: number, height: number) {
  const rungs = selectRenditions({ width, height })
  return {
    rungs,
    names: rungs.map((r) => r.name).join(','),
    sizes: rungs.map((r) => `${r.actualWidth}x${r.actualHeight}`),
  }
}

describe('landscape', () => {
  it('1080p source gets the full ladder', () => {
    const { names, sizes } = ladder(1920, 1080)
    assert.equal(names, '240p,360p,480p,720p,1080p')
    assert.ok(sizes.includes('426x240'), `1080p source dimensions: ${sizes.join(' ')}`)
    assert.ok(sizes.includes('1920x1080'), `1080p source dimensions: ${sizes.join(' ')}`)
  })

  it('720p source is never upscaled to 1080p', () => {
    assert.ok(!ladder(1280, 720).names.includes('1080p'))
  })

  it('360p source stops at 360p', () => {
    assert.equal(ladder(640, 360).names, '240p,360p')
  })
})

describe('portrait', () => {
  it('480x854 is matched on the short side', () => {
    const { names, sizes } = ladder(480, 854)
    assert.equal(names, '240p,360p,480p')
    assert.ok(sizes.includes('480x854'), `top rung keeps native size: ${sizes.join(' ')}`)
  })

  it('480x854 tops out at the 480p bitrate, not 720p', () => {
    // The point of the short-side rule: 480x854 and 854x480 have the same pixel
    // count and must get the same bitrate. Matching on height instead would
    // encode this at 2800 kbps — roughly three times what those pixels need,
    // paid on every byte delivered.
    assert.equal(ladder(480, 854).rungs.at(-1)!.bitrateKbps, 1400)
  })

  it('full-HD portrait tops out at native', () => {
    assert.equal(ladder(1080, 1920).sizes.at(-1), '1080x1920')
  })
})

describe('square and odd shapes', () => {
  it('720x720 tops out at 720p and stays square', () => {
    const { names, sizes } = ladder(720, 720)
    assert.equal(names.split(',').at(-1), '720p')
    assert.equal(sizes.at(-1), '720x720')
  })

  it('cinemascope dimensions are all even', () => {
    const { sizes } = ladder(1920, 800) // 2.40:1
    assert.ok(
      sizes.every((s) => s.split('x').every((n) => Number(n) % 2 === 0)),
      sizes.join(' '),
    )
  })
})

describe('degenerate', () => {
  it('a sub-240p source still gets one playable rung', () => {
    assert.equal(ladder(320, 180).names, '240p')
  })
})

describe('universal invariants', () => {
  const shapes = [
    [1920, 1080],
    [480, 854],
    [720, 720],
    [1920, 800],
    [640, 360],
    [1080, 1920],
  ] as const

  for (const [w, h] of shapes) {
    it(`${w}x${h}: all dimensions even (libx264 requires it)`, () => {
      const { rungs } = ladder(w, h)
      assert.ok(rungs.every((r) => r.actualWidth % 2 === 0 && r.actualHeight % 2 === 0))
    })

    it(`${w}x${h}: never upscales either axis`, () => {
      const { rungs } = ladder(w, h)
      assert.ok(rungs.every((r) => r.actualWidth <= w && r.actualHeight <= h))
    })

    it(`${w}x${h}: aspect ratio preserved`, () => {
      const { rungs } = ladder(w, h)
      assert.ok(rungs.every((r) => Math.abs(r.actualWidth / r.actualHeight - w / h) < 0.02))
    })

    it(`${w}x${h}: peak exceeds target (capped VBR is configured)`, () => {
      const { rungs } = ladder(w, h)
      assert.ok(rungs.every((r) => r.peakBitrateKbps > r.bitrateKbps))
    })
  }
})
