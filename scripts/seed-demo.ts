/**
 * Builds the demo catalogue: generated key visuals, generated footage, and the
 * real transcode pipeline.
 *
 *   npm run seed:demo
 *
 * Replaces whatever demo content is already there. Requires
 * VIDEO_PROVIDER=local, since it writes into public/media/.
 *
 * The footage is a slow Ken Burns move over each title's own landscape
 * backdrop, so the card art and the thing that plays are visibly the same
 * title. That also happens to encode very small — a smooth gradient pan has
 * almost no detail for the encoder to spend bits on — which matters because
 * the demo media ships with the deployment.
 *
 * Nothing here is downloaded. Plan §1 is that this platform holds rights to
 * what it shows, and an ad network will ban a site that does not; seeding it
 * with scraped art would contradict the thing being built.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { renderKeyVisual } from './demo-art.tsx'
import { categories, episodes, series, videoCategories, videos, videoVariants } from '../src/db/schema.ts'
import { transcodeToHls } from '../src/lib/video/pipeline.ts'
import { FFMPEG } from '../src/lib/video/probe.ts'
import { uniqueSlug } from '../src/lib/slug.ts'

const run = promisify(execFile)

if (process.env.VIDEO_PROVIDER !== 'local') {
  console.error('Set VIDEO_PROVIDER=local — this script writes into public/media/.')
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const client = postgres(url, { max: 1 })
const db = drizzle(client)

const { localProvider } = await import('../src/lib/video/local.ts')
const { paths } = await import('../src/lib/video/types.ts')

/**
 * Demo media ships inside the deployment, so both of these are cost decisions
 * rather than creative ones.
 *
 * The clip is short, and it is rendered at 480p so the no-upscale rule caps the
 * ladder at three rungs. Encoded from a 1080p source the same catalogue came to
 * 500 MB, of which 720p and 1080p were 72% — far too much to upload on every
 * deploy, and it proves nothing the 480p ladder does not. Real content is
 * transcoded from whatever the creator uploads and is unaffected by this.
 */
const CLIP_SECONDS = 20
const CLIP_WIDTH = 854
const CLIP_HEIGHT = 480

type Title = {
  title: string
  synopsis: string
  category: string
  genre: string
  ageRating: 'U' | 'UA7' | 'UA13' | 'UA16' | 'A'
  season: string
  score: number
  dub: boolean
  studio: string
  /** Present when this title is a series rather than a one-off. */
  episodes?: { no: number; title: string }[]
  totalEpisodes?: number
}

const CATALOGUE: Title[] = [
  {
    title: 'Sakura no Kiseki', synopsis: 'A transfer student finds the school rooftop opens onto somewhere that should not exist, and the only other person who can see it has been waiting a long time.',
    category: 'slice-of-life', genre: 'Slice of Life', ageRating: 'U', season: 'Fall 2026', score: 84, dub: true, studio: 'Studio Hanabi',
    totalEpisodes: 12,
    episodes: [
      { no: 1, title: 'The Rooftop That Wasn’t There' },
      { no: 2, title: 'Tea for Someone Who Left' },
      { no: 3, title: 'A Door Counts as a Promise' },
    ],
  },
  {
    title: 'Hoshi no Kenshi', synopsis: 'Two rival swordsmen are bound to the same falling star. Neither can die until the other does, and the star is still falling.',
    category: 'shonen', genre: 'Shonen', ageRating: 'UA13', season: 'Fall 2026', score: 91, dub: true, studio: 'Ginga Works',
    totalEpisodes: 24,
    episodes: [
      { no: 1, title: 'One Blade, Two Names' },
      { no: 2, title: 'The Weight of a Falling Star' },
      { no: 3, title: 'What the Dead Owe' },
      { no: 4, title: 'Two Names, One Grave' },
    ],
  },
  { title: 'Isekai Ramen Master', synopsis: 'Summoned to another world with nothing but a noodle cart and an unreasonable amount of confidence.', category: 'isekai', genre: 'Isekai', ageRating: 'U', season: 'Summer 2026', score: 78, dub: false, studio: 'Kettle Animation' },
  { title: 'Yoru no Kissaten', synopsis: 'A late-night cafe where the regulars are not entirely human and the owner has stopped asking.', category: 'supernatural', genre: 'Supernatural', ageRating: 'UA13', season: 'Winter 2026', score: 88, dub: false, studio: 'Studio Hanabi' },
  { title: 'Kikai Otome: Rebuild', synopsis: 'A salvage crew restores a mech that several governments would prefer stayed buried.', category: 'mecha', genre: 'Mecha', ageRating: 'UA16', season: 'Spring 2026', score: 73, dub: true, studio: 'Ginga Works' },
  { title: 'Hanabi Highway', synopsis: 'Three friends, one borrowed van, and every summer festival between here and the sea.', category: 'slice-of-life', genre: 'Slice of Life', ageRating: 'U', season: 'Summer 2026', score: 82, dub: false, studio: 'Kettle Animation' },
  { title: 'Kurayami Detective', synopsis: 'She solves cases the city has already closed, which is why the city keeps closing them.', category: 'seinen', genre: 'Seinen', ageRating: 'UA16', season: 'Fall 2026', score: 86, dub: true, studio: 'Ashen Studio' },
  { title: 'Tenkai Academy', synopsis: 'A school for people whose talents arrived before the instruction manual.', category: 'shonen', genre: 'Shonen', ageRating: 'UA7', season: 'Winter 2026', score: 76, dub: true, studio: 'Studio Hanabi' },
  { title: 'Mirai Bakery', synopsis: 'A bakery that opens only on days that have not happened yet.', category: 'fantasy', genre: 'Fantasy', ageRating: 'U', season: 'Spring 2026', score: 80, dub: false, studio: 'Kettle Animation' },
  { title: 'Ao no Kioku', synopsis: 'Every summer she forgets him. Every summer he decides that is fine.', category: 'romance', genre: 'Romance', ageRating: 'UA13', season: 'Summer 2026', score: 89, dub: true, studio: 'Ashen Studio' },
  { title: 'Zenith Runners', synopsis: 'Rooftop couriers race a city that is quietly rearranging itself beneath them.', category: 'action', genre: 'Action', ageRating: 'UA13', season: 'Fall 2026', score: 75, dub: false, studio: 'Ginga Works' },
  { title: 'Neko Cafe Chronicles', synopsis: 'Nothing much happens, beautifully, for twenty-four minutes at a time.', category: 'comedy', genre: 'Comedy', ageRating: 'U', season: 'Winter 2026', score: 71, dub: true, studio: 'Kettle Animation' },
]

/**
 * A slow zoom and drift across the backdrop, plus a quiet tone.
 *
 * `zoompan` needs its duration in frames, and it runs before `fps`, so the
 * frame count is expressed against the input rate rather than the output.
 */
async function renderClip(backdrop: string, out: string, seed: number): Promise<void> {
  const fps = 25
  const frames = CLIP_SECONDS * fps
  const drift = 0.0009 + (seed % 5) * 0.00012
  const panX = seed % 2 === 0 ? '(iw-iw/zoom)/2+sin(on/240)*80' : '(iw-iw/zoom)/2-sin(on/260)*90'

  await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-loop', '1', '-framerate', String(fps), '-t', String(CLIP_SECONDS), '-i', backdrop,
      '-f', 'lavfi', '-t', String(CLIP_SECONDS), '-i',
      `sine=frequency=${210 + (seed % 7) * 35}:sample_rate=48000`,
      '-filter_complex',
      `[0:v]zoompan=z='min(1+${drift}*on,1.35)':x='${panX}':y='(ih-ih/zoom)/2':d=${frames}:s=${CLIP_WIDTH}x${CLIP_HEIGHT}:fps=${fps},` +
        `format=yuv420p,fade=t=in:d=1.2,fade=t=out:st=${CLIP_SECONDS - 1.2}:d=1.2[v];` +
        `[1:a]volume=0.04,afade=t=in:d=1,afade=t=out:st=${CLIP_SECONDS - 1}:d=1[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', out,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  )
}

const workDir = await mkdtemp(path.join(tmpdir(), 'demo-'))
let count = 0

try {
  // Recycle the previous demo media rather than deleting it outright.
  const mediaRoot = path.join(process.cwd(), 'public', 'media')
  const parked = path.join(homedir(), '.Trash', `media-${Date.now()}`)
  await rename(mediaRoot, parked).then(
    () => console.log(`previous media moved to ${parked}`),
    () => {},
  )

  await db.delete(episodes)
  await db.delete(series)
  await db.delete(videoCategories)
  await db.delete(videoVariants)
  await db.delete(videos)

  for (const entry of CATALOGUE) {
    const seed = count
    const parts = entry.episodes ?? [{ no: 0, title: '' }]

    let seriesId: string | null = null
    if (entry.episodes) {
      const portrait = await renderKeyVisual({
        title: entry.title, kicker: entry.genre,
        footnote: `${entry.season} · ${entry.totalEpisodes} episodes`,
      })
      const banner = await renderKeyVisual({
        title: entry.title, kicker: entry.genre, footnote: entry.studio, orientation: 'landscape',
      })

      const seriesSlug = uniqueSlug(entry.title)
      const artPrefix = `series/${seriesSlug}`
      await localProvider.putObject({ path: `${artPrefix}/portrait.png`, body: portrait, contentType: 'image/png' })
      await localProvider.putObject({ path: `${artPrefix}/banner.png`, body: banner, contentType: 'image/png' })

      const [row] = await db.insert(series).values({
        slug: seriesSlug, title: entry.title, synopsis: entry.synopsis,
        portraitUrl: `${artPrefix}/portrait.png`, bannerUrl: `${artPrefix}/banner.png`,
        status: 'airing', totalEpisodes: entry.totalEpisodes, studio: entry.studio,
        seasonLabel: entry.season, releaseYear: 2026,
      }).returning({ id: series.id })
      seriesId = row!.id
    }

    for (const part of parts) {
      const isEpisode = part.no > 0
      const displayTitle = isEpisode ? `${entry.title} — Ep ${part.no}` : entry.title
      process.stdout.write(`${displayTitle} … `)

      const portrait = await renderKeyVisual({
        title: entry.title,
        kicker: isEpisode ? `Episode ${part.no}` : entry.genre,
        footnote: isEpisode ? part.title : `${entry.season} · ${entry.studio}`,
      })
      const backdropFile = path.join(workDir, `bd-${count}.png`)
      await writeFile(
        backdropFile,
        await renderKeyVisual({
          title: entry.title,
          kicker: isEpisode ? `Episode ${part.no}` : entry.genre,
          footnote: isEpisode ? part.title : entry.studio,
          orientation: 'landscape',
        }),
      )

      const source = path.join(workDir, `clip-${count}.mp4`)
      await renderClip(backdropFile, source, seed + part.no)

      const [video] = await db.insert(videos).values({
        slug: uniqueSlug(displayTitle),
        title: isEpisode ? `${entry.title} — Ep ${part.no}: ${part.title}` : entry.title,
        description: isEpisode ? `${part.title}. ${entry.synopsis}` : entry.synopsis,
        language: 'ja', ageRating: entry.ageRating,
        contentDescriptor: entry.ageRating === 'U' ? null : 'Mild fantasy violence',
        seasonLabel: entry.season, score: entry.score,
        hasSub: true, hasDub: entry.dub,
        status: 'processing', provider: 'local',
      }).returning({ id: videos.id, slug: videos.slug })

      const outDir = path.join(workDir, video!.id)
      const result = await transcodeToHls(source, outDir)
      await localProvider.uploadDirectory({
        localDir: outDir, keyPrefix: paths.prefix(video!.id).replace(/\/$/, ''),
      })

      const portraitPath = `${paths.prefix(video!.id)}portrait.png`
      await localProvider.putObject({ path: portraitPath, body: portrait, contentType: 'image/png' })

      await db.insert(videoVariants).values(
        result.variants.filter((v) => v.height > 0).map((v) => ({
          videoId: video!.id, resolution: v.name, width: v.width, height: v.height,
          bitrateKbps: v.bitrateKbps, peakBitrateKbps: v.peakBitrateKbps,
          playlistPath: `${paths.prefix(video!.id)}${v.playlistPath}`, sizeBytes: v.sizeBytes,
        })),
      )

      const [category] = await db.select({ id: categories.id }).from(categories)
        .where(eq(categories.slug, entry.category)).limit(1)
      if (category) {
        await db.insert(videoCategories)
          .values({ videoId: video!.id, categoryId: category.id }).onConflictDoNothing()
      }

      await db.update(videos).set({
        status: 'published',
        // Staggered so "New Episodes" has a real order rather than one timestamp.
        publishedAt: new Date(Date.now() - count * 36e5),
        durationSec: Math.round(result.probe.durationSec),
        hlsMasterPath: paths.master(video!.id),
        posterUrl: paths.poster(video!.id),
        portraitUrl: portraitPath,
        spriteUrl: paths.sprite(video!.id),
        spriteVttUrl: paths.spriteVtt(video!.id),
        previewUrl: result.previewPath ? paths.preview(video!.id) : null,
      }).where(eq(videos.id, video!.id))

      if (seriesId && isEpisode) {
        await db.insert(episodes).values({
          seriesId, videoId: video!.id, seasonNo: 1, episodeNo: part.no, title: part.title,
        })
      }

      count++
      console.log(`/watch/${video!.slug}`)
    }
  }

  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(videos)
  console.log(`\n${count} titles published, ${row?.c ?? 0} videos total.`)
} finally {
  await rm(workDir, { recursive: true, force: true })
  await client.end()
}
