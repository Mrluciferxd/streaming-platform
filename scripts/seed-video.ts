/**
 * Transcodes videos and publishes them, so the front end has something real to
 * render.
 *
 *   npm run seed:video                 # synthesises two series and three films
 *   npm run seed:video -- input.mp4 "My Film" short-films
 *
 * Requires VIDEO_PROVIDER=local, which writes the HLS package into public/media/
 * for the dev server to serve. Everything else — probe, ladder, packaging,
 * sprites, database rows — is the same code path the worker runs.
 *
 * Series come first because anime is episodic: a catalogue of standalone titles
 * exercises none of the season grouping, next-episode or autoplay paths, and
 * those are the ones most likely to be wrong.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import {
  categories,
  episodes,
  series,
  videoCategories,
  videos,
  videoVariants,
} from '../src/db/schema.ts'
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

type AgeRating = 'U' | 'UA7' | 'UA13' | 'UA16' | 'A'

/** A clip to synthesise when no source file was given. */
type Clip = {
  size: string
  duration: number
  pattern: string
}

type Sample = Clip & {
  title: string
  description: string
  category: string
  language: string
  ageRating: AgeRating
  season: string
  score: number
  dub: boolean
}

type EpisodeSeed = Clip & {
  seasonNo: number
  episodeNo: number
  title: string
  synopsis: string
}

type SeriesSeed = {
  title: string
  synopsis: string
  studio: string
  status: 'airing' | 'completed'
  releaseYear: number
  /** The announced run, which for an airing show is larger than what exists. */
  totalEpisodes: number
  seasonLabel: string
  category: string
  language: string
  ageRating: AgeRating
  score: number
  dub: boolean
  /** Key-visual gradient, in brand colours. */
  keyVisual: [string, string]
  /** Broadcast interval in days — anime airs weekly. */
  airedEveryDays: number
  /** Days ago the most recent episode aired. */
  lastAiredDaysAgo: number
  episodes: EpisodeSeed[]
}

/**
 * Two series, deliberately different shapes.
 *
 * The first is mid-run, so the series page has to say "4 of 12" rather than
 * counting rows. The second is finished and has two seasons, which is the only
 * way to see whether the episode list groups or just concatenates.
 */
const SERIES: SeriesSeed[] = [
  {
    title: 'Hoshi no Kenshi',
    synopsis:
      'Two rival swordsmen are bound to the same falling star, and neither can draw a blade without the other feeling it. A duel that has already been fought once, in a life neither of them remembers.',
    studio: 'Studio Kagerou',
    status: 'airing',
    releaseYear: 2026,
    totalEpisodes: 12,
    seasonLabel: 'Fall 2026',
    category: 'shonen',
    language: 'ja',
    ageRating: 'UA13',
    score: 91,
    dub: true,
    keyVisual: ['0xff5c8a', '0x7c6bf0'],
    airedEveryDays: 7,
    lastAiredDaysAgo: 2,
    episodes: [
      {
        seasonNo: 1,
        episodeNo: 1,
        title: 'The Star That Fell Twice',
        synopsis: 'Rei catches a blade that should have killed him, and the sky answers.',
        size: '1280x720',
        duration: 14,
        pattern: 'smptebars',
      },
      {
        seasonNo: 1,
        episodeNo: 2,
        title: 'A Debt in Iron',
        synopsis: 'The swordsmith who forged both blades has been dead for forty years.',
        size: '1280x720',
        duration: 12,
        pattern: 'testsrc2',
      },
      {
        seasonNo: 1,
        episodeNo: 3,
        title: 'What the River Kept',
        synopsis: 'Asa returns to the village she drowned in and finds it waiting.',
        size: '1920x1080',
        duration: 12,
        pattern: 'smptehdbars',
      },
      {
        seasonNo: 1,
        episodeNo: 4,
        title: 'Two Names, One Grave',
        synopsis: 'The duel begins, and both of them remember losing it.',
        size: '1280x720',
        duration: 14,
        pattern: 'testsrc',
      },
    ],
  },
  {
    title: 'Yoru no Kissaten',
    synopsis:
      'A late-night cafe where the regulars are not entirely human, the coffee is exact, and nobody asks what anyone is running from.',
    studio: 'Mikazuki Animation',
    status: 'completed',
    releaseYear: 2025,
    totalEpisodes: 3,
    seasonLabel: 'Winter 2026',
    category: 'supernatural',
    language: 'ja',
    ageRating: 'UA13',
    score: 88,
    dub: false,
    keyVisual: ['0x16b8a6', '0x2e2a35'],
    airedEveryDays: 7,
    lastAiredDaysAgo: 120,
    episodes: [
      {
        seasonNo: 1,
        episodeNo: 1,
        title: 'Last Orders',
        synopsis: 'The bell above the door rings for a customer who is not there.',
        size: '854x480',
        duration: 12,
        pattern: 'testsrc2',
      },
      {
        seasonNo: 1,
        episodeNo: 2,
        title: 'The Regular',
        synopsis: 'He has ordered the same thing every night for sixty years.',
        size: '854x480',
        duration: 12,
        pattern: 'testsrc',
      },
      {
        seasonNo: 2,
        episodeNo: 1,
        title: 'Reopening',
        synopsis: 'New owner, same rules — and the rules were never negotiable.',
        size: '1280x720',
        duration: 12,
        pattern: 'smptebars',
      },
    ],
  },
]

/**
 * Standalone titles. Distinct sizes and aspect ratios on purpose: a portrait
 * clip and a 360p clip exercise short-side ladder matching and the no-upscale
 * rule, which a set of identical 720p samples would not.
 */
const SAMPLES: Sample[] = [
  { title: 'Sakura no Kiseki', description: 'A transfer student discovers the school rooftop leads somewhere it should not.', category: 'slice-of-life', language: 'ja', ageRating: 'U', size: '1280x720', duration: 20, pattern: 'testsrc2', season: 'Fall 2026', score: 84, dub: true },
  { title: 'Isekai Ramen Master', description: 'Summoned to another world with nothing but a noodle cart.', category: 'isekai', language: 'ja', ageRating: 'U', size: '480x854', duration: 14, pattern: 'testsrc', season: 'Summer 2026', score: 78, dub: false },
  { title: 'Kikai Otome: Rebuild', description: 'Salvage-crew pilots restore a mech nobody wants found.', category: 'mecha', language: 'ja', ageRating: 'UA16', size: '640x360', duration: 18, pattern: 'smptehdbars', season: 'Spring 2026', score: 73, dub: true },
]

const workDir = await mkdtemp(path.join(tmpdir(), 'seed-'))
let published = 0

/** Synthesises a clip with a distinct tone per item, so they are told apart by ear. */
async function synthesise(clip: Clip, label: string): Promise<string> {
  const source = path.join(workDir, `${label}.mp4`)
  process.stdout.write(`synthesising ${clip.size}… `)

  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `${clip.pattern}=size=${clip.size}:rate=25:duration=${clip.duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=${300 + published * 60}:duration=${clip.duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    source,
  ])

  return source
}

type PublishInput = {
  title: string
  description: string
  category: string
  language: string
  ageRating: AgeRating
  seasonLabel: string | null
  score: number | null
  dub: boolean
  source: string
}

/** The worker's path, minus the queue: row, transcode, package, variants, publish. */
async function publishVideo(input: PublishInput): Promise<{ id: string; slug: string }> {
  const [video] = await db
    .insert(videos)
    .values({
      slug: uniqueSlug(input.title),
      title: input.title,
      description: input.description,
      language: input.language,
      ageRating: input.ageRating,
      contentDescriptor: input.ageRating === 'U' ? null : 'Mild fantasy violence',
      seasonLabel: input.seasonLabel,
      score: input.score,
      // Subs on everything, dubs only where recorded — the split an anime
      // catalogue actually has.
      hasSub: true,
      hasDub: input.dub,
      status: 'processing',
      provider: 'local',
    })
    .returning({ id: videos.id, slug: videos.slug })

  if (!video) throw new Error(`could not create a video row for ${input.title}`)

  const outDir = path.join(workDir, video.id)
  process.stdout.write('transcoding… ')

  const result = await transcodeToHls(input.source, outDir)

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
    .where(eq(categories.slug, input.category))
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
      /**
       * No invented view count.
       *
       * This used to seed a random number so the rails looked populated. Now
       * that telemetry is live, `view_count` is owned by `rollup_video_stats`,
       * which only touches videos that have a row in `video_stats_daily` — so a
       * fabricated number on a video nobody has watched is never corrected and
       * sits there permanently. Starting at zero means the counts on screen are
       * always real.
       */
    })
    .where(eq(videos.id, video.id))

  published++
  const sizes = result.variants.filter((v) => v.height > 0).map((v) => v.name).join(', ')
  console.log(`published /watch/${video.slug}  [${sizes}]`)

  return video
}

/**
 * A 2:3 key visual and a wide banner for the series page.
 *
 * Synthesised rather than skipped because a series page with an empty art slot
 * proves nothing about whether the columns are wired — and these are stored as
 * bucket-relative paths like every other asset, so the provider resolves them.
 */
async function attachKeyVisuals(seriesId: string, colours: [string, string]) {
  const artDir = path.join(workDir, `series-${seriesId}`)
  await mkdir(artDir, { recursive: true })

  const draw = async (size: string, file: string) => {
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i',
      `gradients=size=${size}:c0=${colours[0]}:c1=${colours[1]}:n=2:duration=1`,
      '-frames:v', '1',
      path.join(artDir, file),
    ])
  }

  await draw('800x1200', 'portrait.jpg')
  await draw('1600x500', 'banner.jpg')

  await localProvider.uploadDirectory({ localDir: artDir, keyPrefix: `s/${seriesId}` })

  return {
    portraitUrl: `s/${seriesId}/portrait.jpg`,
    bannerUrl: `s/${seriesId}/banner.jpg`,
  }
}

try {
  const customInput = process.argv[2]

  if (customInput) {
    await publishVideo({
      title: process.argv[3] ?? path.basename(customInput, path.extname(customInput)),
      description: '',
      category: process.argv[4] ?? 'action',
      language: 'hi',
      ageRating: 'U',
      seasonLabel: null,
      score: null,
      dub: false,
      source: path.resolve(customInput),
    })
  } else {
    for (const show of SERIES) {
      const [row] = await db
        .insert(series)
        .values({
          slug: uniqueSlug(show.title),
          title: show.title,
          synopsis: show.synopsis,
          status: show.status,
          totalEpisodes: show.totalEpisodes,
          studio: show.studio,
          releaseYear: show.releaseYear,
          seasonLabel: show.seasonLabel,
        })
        .returning({ id: series.id, slug: series.slug })

      if (!row) throw new Error(`could not create a series row for ${show.title}`)

      const art = await attachKeyVisuals(row.id, show.keyVisual)
      let firstVideoId: string | null = null

      for (const [index, episode] of show.episodes.entries()) {
        const source = await synthesise(episode, `${row.id}-${index}`)

        const video = await publishVideo({
          // The video title carries the show and the number because that is what
          // search, sitemaps and Google match against; `episodes.title` holds the
          // bare title the episode list renders.
          title: `${show.title} Episode ${episode.episodeNo} — ${episode.title}`,
          description: episode.synopsis,
          category: show.category,
          language: show.language,
          ageRating: show.ageRating,
          seasonLabel: show.seasonLabel,
          score: show.score,
          dub: show.dub,
          source,
        })

        firstVideoId ??= video.id

        // Weekly, counting back from the most recent — so an airing show has a
        // last episode from a few days ago rather than a schedule in the future.
        const stepsBack = show.episodes.length - 1 - index
        const airedAt = new Date(
          Date.now() -
            (show.lastAiredDaysAgo + stepsBack * show.airedEveryDays) * 86_400_000,
        )

        await db.insert(episodes).values({
          seriesId: row.id,
          videoId: video.id,
          seasonNo: episode.seasonNo,
          episodeNo: episode.episodeNo,
          title: episode.title,
          synopsis: episode.synopsis,
          // The seed has no separate still to upload, so the episode reuses the
          // poster the pipeline already extracted. A real upload replaces it.
          thumbnailUrl: paths.poster(video.id),
          airedAt,
        })
      }

      await db
        .update(series)
        .set({
          ...art,
          posterUrl: firstVideoId ? paths.poster(firstVideoId) : null,
          updatedAt: new Date(),
        })
        .where(eq(series.id, row.id))

      console.log(`series   /series/${row.slug}  [${show.episodes.length} episodes]\n`)
    }

    for (const sample of SAMPLES) {
      const source = await synthesise(sample, `${sample.pattern}-${sample.size}`)

      await publishVideo({
        title: sample.title,
        description: sample.description,
        category: sample.category,
        language: sample.language,
        ageRating: sample.ageRating,
        seasonLabel: sample.season || null,
        score: sample.score || null,
        dub: sample.dub,
        source,
      })
    }
  }

  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(videos)
  console.log(`\n${published} published, ${row?.count ?? 0} videos total.`)
} finally {
  await rm(workDir, { recursive: true, force: true })
  await client.end()
}
