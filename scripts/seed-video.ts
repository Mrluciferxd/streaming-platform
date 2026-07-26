/**
 * Transcodes a video and publishes it, so the front end has something real to
 * render.
 *
 *   npm run seed:video                 # synthesises clips
 *   npm run seed:video -- input.mp4 "My Film" short-films
 *
 * Requires VIDEO_PROVIDER=local, which writes the HLS package into public/media/
 * for the dev server to serve. Everything else — probe, ladder, packaging,
 * sprites, database rows — is the same code path the worker runs.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { categories, videoCategories, videos, videoVariants } from '../src/db/schema.ts'
import { transcodeToHls } from '../src/lib/video/pipeline.ts'
import { FFMPEG } from '../src/lib/video/probe.ts'
import { uniqueSlug } from '../src/lib/slug.ts'

const run = promisify(execFile)

if (process.env.VIDEO_PROVIDER !== 'local') {
  console.error('Set VIDEO_PROVIDER=local in .env.local — this script writes into public/media/.')
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const client = postgres(url, { max: 1 })
const db = drizzle(client)

// Imported after the provider check so it picks up VIDEO_PROVIDER=local.
const { localProvider } = await import('../src/lib/video/local.ts')
const { paths } = await import('../src/lib/video/types.ts')

type Sample = {
  title: string
  description: string
  category: string
  language: string
  ageRating: 'U' | 'UA7' | 'UA13' | 'UA16' | 'A'
  size: string
  duration: number
  pattern: string
}

/**
 * Distinct sizes and aspect ratios on purpose: a portrait clip and a 360p clip
 * exercise short-side ladder matching and the no-upscale rule, which a set of
 * identical 720p samples would not.
 */
const SAMPLES: Sample[] = [
  { title: 'મારી ફિલ્મ', description: 'A Gujarati short film.', category: 'short-films', language: 'gu', ageRating: 'U', size: '1280x720', duration: 20, pattern: 'testsrc2' },
  { title: 'मेरी वेब सीरीज़', description: 'Episode one of a Hindi web series.', category: 'web-series', language: 'hi', ageRating: 'UA13', size: '1920x1080', duration: 16, pattern: 'smptebars' },
  { title: 'Street Food of Ahmedabad', description: 'A walk through the night market.', category: 'food-travel', language: 'en', ageRating: 'U', size: '854x480', duration: 14, pattern: 'testsrc' },
  { title: 'Vertical Comedy Clip', description: 'Shot on a phone, as most things are.', category: 'comedy', language: 'hi', ageRating: 'UA7', size: '480x854', duration: 12, pattern: 'testsrc2' },
  { title: 'Morning Raga', description: 'Live recording.', category: 'music', language: 'hi', ageRating: 'U', size: '640x360', duration: 18, pattern: 'smptehdbars' },
]

const workDir = await mkdtemp(path.join(tmpdir(), 'seed-'))
let published = 0

try {
  const customInput = process.argv[2]
  const list: Sample[] = customInput
    ? [
        {
          title: process.argv[3] ?? path.basename(customInput, path.extname(customInput)),
          description: '',
          category: process.argv[4] ?? 'short-films',
          language: 'hi',
          ageRating: 'U',
          size: '',
          duration: 0,
          pattern: '',
        },
      ]
    : SAMPLES

  for (const sample of list) {
    let source: string

    if (customInput) {
      source = path.resolve(customInput)
    } else {
      source = path.join(workDir, `${sample.pattern}-${sample.size}.mp4`)
      process.stdout.write(`synthesising ${sample.size}… `)

      await run(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `${sample.pattern}=size=${sample.size}:rate=25:duration=${sample.duration}`,
        '-f', 'lavfi', '-i', `sine=frequency=${300 + published * 60}:duration=${sample.duration}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest',
        source,
      ])
    }

    const [video] = await db
      .insert(videos)
      .values({
        slug: uniqueSlug(sample.title),
        title: sample.title,
        description: sample.description,
        language: sample.language,
        ageRating: sample.ageRating,
        contentDescriptor: sample.ageRating === 'U' ? null : 'Mild language',
        status: 'processing',
        provider: 'local',
      })
      .returning({ id: videos.id, slug: videos.slug })

    if (!video) continue

    const outDir = path.join(workDir, video.id)
    process.stdout.write('transcoding… ')

    const result = await transcodeToHls(source, outDir)

    process.stdout.write('storing… ')
    await localProvider.uploadDirectory({
      localDir: outDir,
      keyPrefix: paths.prefix(video.id).replace(/\/$/, ''),
    })

    await db.insert(videoVariants).values(
      result.variants
        .filter((v) => v.height > 0)
        .map((v) => ({
          videoId: video.id,
          resolution: v.name,
          width: v.width,
          height: v.height,
          bitrateKbps: v.bitrateKbps,
          peakBitrateKbps: v.peakBitrateKbps,
          playlistPath: `${paths.prefix(video.id)}${v.playlistPath}`,
          sizeBytes: v.sizeBytes,
        })),
    )

    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, sample.category))
      .limit(1)

    if (category) {
      await db
        .insert(videoCategories)
        .values({ videoId: video.id, categoryId: category.id })
        .onConflictDoNothing()
    }

    await db
      .update(videos)
      .set({
        status: 'published',
        publishedAt: new Date(),
        durationSec: Math.round(result.probe.durationSec),
        hlsMasterPath: paths.master(video.id),
        posterUrl: paths.poster(video.id),
        spriteUrl: paths.sprite(video.id),
        spriteVttUrl: paths.spriteVtt(video.id),
        previewUrl: result.previewPath ? paths.preview(video.id) : null,
        // Something plausible so the trending rail and view counts render.
        viewCount: Math.floor(Math.random() * 40_000),
      })
      .where(eq(videos.id, video.id))

    published++
    const sizes = result.variants.filter((v) => v.height > 0).map((v) => v.name).join(', ')
    console.log(`published /watch/${video.slug}  [${sizes}]`)
  }

  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(videos)
  console.log(`\n${published} published, ${row?.count ?? 0} videos total.`)
} finally {
  await rm(workDir, { recursive: true, force: true })
  await client.end()
}
