/**
 * Generates portrait key visuals for the demo catalogue.
 *
 *   npx tsx scripts/demo-art.tsx ./out
 *
 * Why generate rather than download: this platform's entire premise is that it
 * holds rights to what it shows (plan §1), and an ad network will ban a site
 * that does not. Seeding it with scraped anime art would contradict the thing
 * being built. Everything here is composed from gradients and geometry, so it
 * is ours, it is free of any licence question, and it still gives the 2:3 cards
 * something real to render — which colour bars never did.
 *
 * Rendered with satori + resvg, both already bundled inside next/og, so this
 * adds no dependency. Imported from the internal path because the `next/og`
 * entry point resolves only inside a Next build.
 */
import { readFile } from 'node:fs/promises'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ImageResponse } = (await import(
  'next/dist/server/og/image-response.js'
)) as any

export const KEY_VISUAL_WIDTH = 600
export const KEY_VISUAL_HEIGHT = 900

/** Rounded and geometric, matching the site's Baloo/Quicksand pairing. */
const DISPLAY_FONT = '/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf'

/**
 * Palettes drawn from the site's own tokens so a row of cards reads as one
 * catalogue rather than a swatch test. Each is a background pair plus the
 * accent used for the celestial disc.
 */
const PALETTES = [
  { from: '#ff5c8a', to: '#7c6bf0', disc: '#ffd9e5', ink: '#2b1b3d' },
  { from: '#7c6bf0', to: '#38bdf8', disc: '#e9e5ff', ink: '#16203d' },
  { from: '#16b8a6', to: '#7c6bf0', disc: '#ccf5ef', ink: '#0d2b2b' },
  { from: '#f59e0b', to: '#ff5c8a', disc: '#ffe8c2', ink: '#3d1f1b' },
  { from: '#38bdf8', to: '#16b8a6', disc: '#d9f4ff', ink: '#0b2a35' },
  { from: '#a855f7', to: '#ff5c8a', disc: '#f0dcff', ink: '#2a1236' },
  { from: '#0ea5e9', to: '#1e1b4b', disc: '#bae6fd', ink: '#0a1636' },
  { from: '#ff8fab', to: '#f59e0b', disc: '#fff1e0', ink: '#3d2418' },
]

/** Stable per-title variation — the same title always gets the same art. */
function seedOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

type Element = { type: string; props: Record<string, unknown> }
const el = (type: string, props: Record<string, unknown>): Element => ({ type, props })

export type KeyVisualInput = {
  title: string
  kicker?: string | null
  /** Shown small under the title — season, studio, whatever fits. */
  footnote?: string | null
  /** Portrait for cards, landscape for backdrops and video. */
  orientation?: 'portrait' | 'landscape'
}

function compose({ title, kicker, footnote, orientation = 'portrait' }: KeyVisualInput): Element {
  const wide = orientation === 'landscape'
  const seed = seedOf(title)
  const palette = PALETTES[seed % PALETTES.length]!

  // Disc placement varies but stays in the upper two-thirds, so it never
  // collides with the title block.
  const discSize = (wide ? 380 : 260) + (seed % 5) * 40
  const discTop = (wide ? 60 : 90) + ((seed >> 3) % 5) * 45
  const discLeft = (wide ? 900 : -40) + ((seed >> 6) % 7) * 60
  const angle = 120 + ((seed >> 9) % 6) * 20

  return el('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      position: 'relative',
      background: `linear-gradient(${angle}deg, ${palette.from}, ${palette.to})`,
    },
    children: [
      // Celestial disc — the single strongest "this is a poster" cue.
      el('div', {
        style: {
          position: 'absolute',
          top: discTop,
          left: discLeft,
          width: discSize,
          height: discSize,
          borderRadius: discSize,
          background: palette.disc,
          opacity: 0.85,
        },
      }),

      /**
       * Two oversized translucent discs. satori has no blur filter, so depth
       * comes from overlapping low-opacity shapes rather than from softening.
       */
      el('div', {
        style: {
          position: 'absolute',
          top: (wide ? 260 : 380) + ((seed >> 12) % 4) * 50,
          left: (wide ? 300 : 240) + ((seed >> 15) % 4) * 60,
          width: wide ? 620 : 420,
          height: wide ? 620 : 420,
          borderRadius: 620,
          background: '#ffffff',
          opacity: 0.12,
        },
      }),
      el('div', {
        style: {
          position: 'absolute',
          top: -120,
          left: wide ? 1250 : 300,
          width: wide ? 560 : 460,
          height: wide ? 560 : 460,
          borderRadius: 560,
          background: palette.ink,
          opacity: 0.18,
        },
      }),

      // Horizon band, low in the frame, giving the composition a ground.
      el('div', {
        style: {
          position: 'absolute',
          top: (wide ? 640 : 560) + ((seed >> 18) % 3) * 40,
          left: 0,
          width: '100%',
          height: 3,
          background: '#ffffff',
          opacity: 0.35,
        },
      }),

      // Scrim so the title stays legible over whatever landed behind it.
      el('div', {
        style: {
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: '100%',
          height: wide ? 460 : 420,
          background: `linear-gradient(180deg, rgba(0,0,0,0), ${palette.ink})`,
        },
      }),

      el('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          position: 'absolute',
          bottom: wide ? 70 : 46,
          left: wide ? 80 : 44,
          right: wide ? 80 : 44,
        },
        children: [
          kicker
            ? el('div', {
                style: {
                  display: 'flex',
                  color: palette.disc,
                  fontSize: 22,
                  letterSpacing: 4,
                  marginBottom: 10,
                  opacity: 0.95,
                },
                children: kicker.toUpperCase(),
              })
            : null,
          el('div', {
            style: {
              display: 'flex',
              color: '#ffffff',
              fontSize: wide ? (title.length > 22 ? 78 : 96) : title.length > 22 ? 52 : 64,
              lineHeight: 1.05,
              letterSpacing: -1,
            },
            children: title,
          }),
          footnote
            ? el('div', {
                style: {
                  display: 'flex',
                  color: '#ffffff',
                  opacity: 0.75,
                  fontSize: 24,
                  marginTop: 14,
                },
                children: footnote,
              })
            : null,
        ].filter(Boolean),
      }),
    ],
  })
}

export const BACKDROP_WIDTH = 1920
export const BACKDROP_HEIGHT = 1080

export async function renderKeyVisual(input: KeyVisualInput): Promise<Buffer> {
  const font = await readFile(DISPLAY_FONT)
  const wide = input.orientation === 'landscape'

  const response = new ImageResponse(compose(input), {
    width: wide ? BACKDROP_WIDTH : KEY_VISUAL_WIDTH,
    height: wide ? BACKDROP_HEIGHT : KEY_VISUAL_HEIGHT,
    fonts: [{ name: 'Display', data: font, weight: 700, style: 'normal' }],
  })

  return Buffer.from(await response.arrayBuffer())
}

// --- CLI --------------------------------------------------------------------
if (import.meta.filename === process.argv[1]) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = await import('node:path')

  const outDir = path.resolve(process.argv[2] ?? './demo-art')
  await mkdir(outDir, { recursive: true })

  const samples: KeyVisualInput[] = [
    { title: 'Sakura no Kiseki', kicker: 'Slice of Life', footnote: 'Fall 2026 · 12 episodes' },
    { title: 'Hoshi no Kenshi', kicker: 'Shonen', footnote: 'Fall 2026 · 24 episodes' },
    { title: 'Isekai Ramen Master', kicker: 'Isekai', footnote: 'Summer 2026 · 12 episodes' },
  ]

  for (const sample of samples) {
    const file = path.join(outDir, `${sample.title.toLowerCase().replace(/\W+/g, '-')}.png`)
    await writeFile(file, await renderKeyVisual(sample))
    console.log(`wrote ${file}`)
  }
}
