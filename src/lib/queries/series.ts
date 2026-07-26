import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'

import { categories, db, episodes, series, videoCategories, videos } from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'
import { getVideoProvider } from '@/lib/video'

/**
 * Read queries for series and episodes.
 *
 * Same two rules as src/lib/queries/videos.ts: only live videos are ever
 * returned, and stored paths are resolved to URLs here rather than in a
 * component — the database holds bucket-relative paths so a provider swap stays
 * a config change.
 *
 * A series row is public as soon as one of its episodes is; there is no
 * separate publish flag on `series`. Episode 1 going live is what makes a show
 * exist for a viewer, and a second switch would only be a way to publish a
 * catalogue page with nothing to watch behind it.
 */

/** Mirrors the private predicate in queries/videos.ts, which is what `videos_published_idx` covers. */
const isLive = publiclyVisible

export type SeriesStatus = (typeof series.$inferSelect)['status']

export type EpisodeListItem = {
  videoId: string
  slug: string
  seasonNo: number
  episodeNo: number
  /** The episode's own title, or the video's when none was recorded. */
  title: string
  synopsis: string | null
  thumbnailUrl: string | null
  durationSec: number | null
  airedAt: Date | null
}

export type SeriesSeason = {
  seasonNo: number
  episodes: EpisodeListItem[]
}

export type SeriesDetail = {
  id: string
  slug: string
  title: string
  synopsis: string | null
  posterUrl: string | null
  portraitUrl: string | null
  bannerUrl: string | null
  status: SeriesStatus
  totalEpisodes: number | null
  studio: string | null
  releaseYear: number | null
  seasonLabel: string | null
  /** Flat, in broadcast order across seasons. */
  episodes: EpisodeListItem[]
  seasons: SeriesSeason[]
}

/** What a series rail or grid needs — no episode bodies. */
export type SeriesCard = {
  id: string
  slug: string
  title: string
  portraitUrl: string | null
  posterUrl: string | null
  status: SeriesStatus
  seasonLabel: string | null
  releaseYear: number | null
  studio: string | null
  totalEpisodes: number | null
  /** Episodes actually available to watch, which while airing is the smaller number. */
  episodeCount: number
}

const episodeColumns = {
  videoId: videos.id,
  slug: videos.slug,
  seasonNo: episodes.seasonNo,
  episodeNo: episodes.episodeNo,
  episodeTitle: episodes.title,
  videoTitle: videos.title,
  synopsis: episodes.synopsis,
  thumbnailUrl: episodes.thumbnailUrl,
  posterUrl: videos.posterUrl,
  durationSec: videos.durationSec,
  airedAt: episodes.airedAt,
}

type EpisodeRow = {
  videoId: string
  slug: string
  seasonNo: number
  episodeNo: number
  episodeTitle: string | null
  videoTitle: string
  synopsis: string | null
  thumbnailUrl: string | null
  posterUrl: string | null
  durationSec: number | null
  airedAt: Date | null
}

/**
 * The published episodes of a series, in broadcast order.
 *
 * Shared by the series page, the watch page's episode list, and next/previous —
 * all three want the same ordered list, and ordering in the query means the
 * `episodes_series_season_ep_key` index does the work rather than a sort.
 */
async function loadEpisodes(seriesId: string): Promise<EpisodeListItem[]> {
  const rows: EpisodeRow[] = await db
    .select(episodeColumns)
    .from(episodes)
    .innerJoin(videos, eq(videos.id, episodes.videoId))
    .where(and(eq(episodes.seriesId, seriesId), isLive))
    .orderBy(asc(episodes.seasonNo), asc(episodes.episodeNo))

  if (rows.length === 0) return []

  const provider = await getVideoProvider()

  return rows.map((row) => ({
    videoId: row.videoId,
    slug: row.slug,
    seasonNo: row.seasonNo,
    episodeNo: row.episodeNo,
    title: row.episodeTitle ?? row.videoTitle,
    synopsis: row.synopsis,
    // The episode still is commissioned art; the poster is a frame lifted out of
    // the video. Prefer the still, fall back so the list never renders a hole.
    thumbnailUrl: (() => {
      const path = row.thumbnailUrl ?? row.posterUrl
      return path ? provider.publicUrl(path) : null
    })(),
    durationSec: row.durationSec,
    airedAt: row.airedAt,
  }))
}

function groupBySeason(items: EpisodeListItem[]): SeriesSeason[] {
  const seasons: SeriesSeason[] = []

  // The list is already ordered by season, so a running group is enough.
  for (const item of items) {
    const current = seasons.at(-1)
    if (current && current.seasonNo === item.seasonNo) current.episodes.push(item)
    else seasons.push({ seasonNo: item.seasonNo, episodes: [item] })
  }

  return seasons
}

export async function getSeriesBySlug(slug: string): Promise<SeriesDetail | null> {
  const [row] = await db.select().from(series).where(eq(series.slug, slug)).limit(1)
  if (!row) return null

  const items = await loadEpisodes(row.id)
  const provider = await getVideoProvider()
  const url = (path: string | null) => (path ? provider.publicUrl(path) : null)

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    synopsis: row.synopsis,
    posterUrl: url(row.posterUrl),
    portraitUrl: url(row.portraitUrl),
    bannerUrl: url(row.bannerUrl),
    status: row.status,
    totalEpisodes: row.totalEpisodes,
    studio: row.studio,
    releaseYear: row.releaseYear,
    seasonLabel: row.seasonLabel,
    episodes: items,
    seasons: groupBySeason(items),
  }
}

const seriesCardColumns = {
  id: series.id,
  slug: series.slug,
  title: series.title,
  portraitUrl: series.portraitUrl,
  posterUrl: series.posterUrl,
  status: series.status,
  seasonLabel: series.seasonLabel,
  releaseYear: series.releaseYear,
  studio: series.studio,
  totalEpisodes: series.totalEpisodes,
  updatedAt: series.updatedAt,
}

async function toSeriesCards(
  rows: (SeriesCard & { updatedAt?: Date })[],
): Promise<SeriesCard[]> {
  if (rows.length === 0) return []

  const provider = await getVideoProvider()
  const url = (path: string | null) => (path ? provider.publicUrl(path) : null)

  return rows.map(({ updatedAt: _updatedAt, ...row }) => ({
    ...row,
    portraitUrl: url(row.portraitUrl),
    posterUrl: url(row.posterUrl),
  }))
}

/**
 * Series that have a published episode in a category.
 *
 * Categories are assigned per video rather than per series on purpose — a
 * second taxonomy on `series` would be a second thing to keep in sync, and it
 * would disagree with the video's own tagging the first time someone edited one
 * of them. A series belongs to a category because its episodes do.
 */
export async function listSeriesByCategory(
  categorySlug: string,
  limit = 24,
): Promise<SeriesCard[]> {
  const rows = await db
    .select({
      ...seriesCardColumns,
      episodeCount: sql<number>`count(distinct ${videos.id})::int`,
    })
    .from(series)
    .innerJoin(episodes, eq(episodes.seriesId, series.id))
    .innerJoin(videos, and(eq(videos.id, episodes.videoId), isLive))
    .innerJoin(videoCategories, eq(videoCategories.videoId, videos.id))
    .innerJoin(categories, eq(categories.id, videoCategories.categoryId))
    .where(eq(categories.slug, categorySlug))
    .groupBy(series.id)
    .orderBy(desc(series.updatedAt))
    .limit(limit)

  return toSeriesCards(rows)
}

/**
 * Currently airing, newest activity first.
 *
 * The inner join means a series with nothing published yet stays out of the
 * rail: "Airing now" is a place to start watching, and a tile that leads to an
 * empty page is worse than one tile fewer.
 */
export async function listAiringSeries(limit = 12): Promise<SeriesCard[]> {
  const rows = await db
    .select({
      ...seriesCardColumns,
      episodeCount: sql<number>`count(distinct ${videos.id})::int`,
    })
    .from(series)
    .innerJoin(episodes, eq(episodes.seriesId, series.id))
    .innerJoin(videos, and(eq(videos.id, episodes.videoId), isLive))
    .where(eq(series.status, 'airing'))
    .groupBy(series.id)
    .orderBy(desc(series.updatedAt))
    .limit(limit)

  return toSeriesCards(rows)
}

export type EpisodeContext = {
  series: {
    id: string
    slug: string
    title: string
    status: SeriesStatus
    totalEpisodes: number | null
  }
  current: EpisodeListItem
  previous: EpisodeListItem | null
  next: EpisodeListItem | null
  /** Every published episode, ordered — the watch page renders the list too. */
  episodes: EpisodeListItem[]
  seasons: SeriesSeason[]
}

/**
 * Where a video sits in its series, if it sits in one at all.
 *
 * Returns null for a standalone film, which is the signal the watch page uses
 * to fall back to "More Like This".
 *
 * Next and previous are resolved by walking the ordered list rather than by two
 * more round trips, because the page needs the whole list anyway to render the
 * episode picker. Two window-function queries would be the right answer only if
 * the list were not already on the page — and they would still not survive a
 * gap in numbering, which an unpublished or withdrawn episode creates.
 */
export async function getEpisodeContext(videoId: string): Promise<EpisodeContext | null> {
  const [placement] = await db
    .select({
      id: series.id,
      slug: series.slug,
      title: series.title,
      status: series.status,
      totalEpisodes: series.totalEpisodes,
    })
    .from(episodes)
    .innerJoin(series, eq(series.id, episodes.seriesId))
    .where(eq(episodes.videoId, videoId))
    .limit(1)

  if (!placement) return null

  const items = await loadEpisodes(placement.id)
  const index = items.findIndex((item) => item.videoId === videoId)

  // The video is an episode but is not itself published — reachable only for a
  // preview or an operator, and there is no list position to sit in.
  const current = index >= 0 ? items[index] : undefined
  if (!current) return null

  return {
    series: placement,
    current,
    previous: items[index - 1] ?? null,
    next: items[index + 1] ?? null,
    episodes: items,
    seasons: groupBySeason(items),
  }
}

/** Slugs for generateStaticParams. Only series with something to watch. */
export async function listSeriesSlugs(limit = 5_000): Promise<string[]> {
  const rows = await db
    .selectDistinct({ slug: series.slug })
    .from(series)
    .innerJoin(episodes, eq(episodes.seriesId, series.id))
    .innerJoin(videos, and(eq(videos.id, episodes.videoId), isLive))
    .limit(limit)

  return rows.map((row) => row.slug)
}
