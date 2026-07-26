import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import {
  categories,
  db,
  videoCategories,
  videos,
  videoStatsDaily,
  videoVariants,
} from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'
import { getVideoProvider } from '@/lib/video'

/**
 * Read queries for the public surface.
 *
 * Two rules hold throughout:
 *
 *   - Pagination is cursor-based, never OFFSET. `OFFSET 10000` makes Postgres
 *     scan and discard 10,000 rows on every infinite-scroll request (plan §6).
 *   - Every list query filters on `status = 'published' AND deleted_at IS NULL`,
 *     which is exactly the partial index `videos_published_idx` covers.
 */

export type VideoCard = {
  id: string
  slug: string
  title: string
  durationSec: number | null
  posterUrl: string | null
  portraitUrl: string | null
  previewUrl: string | null
  language: string
  ageRating: string
  hasSub: boolean
  hasDub: boolean
  seasonLabel: string | null
  score: number | null
  viewCount: number
  publishedAt: Date | null
}

const cardColumns = {
  id: videos.id,
  slug: videos.slug,
  title: videos.title,
  durationSec: videos.durationSec,
  posterUrl: videos.posterUrl,
  portraitUrl: videos.portraitUrl,
  previewUrl: videos.previewUrl,
  language: videos.language,
  ageRating: videos.ageRating,
  hasSub: videos.hasSub,
  hasDub: videos.hasDub,
  seasonLabel: videos.seasonLabel,
  score: videos.score,
  viewCount: videos.viewCount,
  publishedAt: videos.publishedAt,
}

/** The predicate behind `videos_published_idx`. Kept in one place so a query cannot drift off the index. */
const isLive = publiclyVisible

export type Cursor = { publishedAt: Date; id: string } | null

/** Encode a cursor for the client. Opaque so the shape can change later. */
export function encodeCursor(row: { publishedAt: Date | null; id: string }): string | null {
  if (!row.publishedAt) return null
  return Buffer.from(`${row.publishedAt.toISOString()}|${row.id}`).toString('base64url')
}

export function decodeCursor(raw: string | null | undefined): Cursor {
  if (!raw) return null

  try {
    const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|')
    if (!iso || !id) return null

    const publishedAt = new Date(iso)
    return Number.isNaN(publishedAt.getTime()) ? null : { publishedAt, id }
  } catch {
    return null
  }
}

/**
 * Keyset predicate for "older than this cursor".
 *
 * The id tiebreaker matters: `published_at` is not unique — a bulk import can
 * give dozens of rows the same timestamp — and without it those rows would
 * repeat or vanish across page boundaries.
 */
function olderThan(cursor: Cursor) {
  if (!cursor) return undefined

  return or(
    sql`${videos.publishedAt} < ${cursor.publishedAt}`,
    and(sql`${videos.publishedAt} = ${cursor.publishedAt}`, sql`${videos.id} < ${cursor.id}`),
  )
}

export type Page<T> = { items: T[]; nextCursor: string | null }

/**
 * Turn stored paths into URLs.
 *
 * The database holds bucket-relative paths ("v/<id>/poster.jpg"), never
 * provider-shaped URLs — that is what keeps a Bunny-to-R2 migration a config
 * change rather than a rewrite of every row. The cost is that nothing may hand
 * a raw path to a component, so every read path resolves here.
 */
async function withAssetUrls<
  T extends { posterUrl: string | null; portraitUrl?: string | null; previewUrl?: string | null },
>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows

  const provider = await getVideoProvider()
  const resolve = (path: string | null | undefined) => (path ? provider.publicUrl(path) : null)

  return rows.map((row) => ({
    ...row,
    posterUrl: resolve(row.posterUrl),
    ...(row.portraitUrl === undefined ? {} : { portraitUrl: resolve(row.portraitUrl) }),
    ...(row.previewUrl === undefined ? {} : { previewUrl: resolve(row.previewUrl) }),
  }))
}

async function toPage(rows: VideoCard[], limit: number): Promise<Page<VideoCard>> {
  const items = await withAssetUrls(rows.slice(0, limit))
  const last = rows.slice(0, limit).at(-1)

  return {
    items,
    // The cursor is built from the raw row, before URL resolution touches it.
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  }
}

export async function listLatest(limit = 24, cursor: Cursor = null): Promise<Page<VideoCard>> {
  const rows = await db
    .select(cardColumns)
    .from(videos)
    .where(and(isLive, olderThan(cursor)))
    .orderBy(desc(videos.publishedAt), desc(videos.id))
    .limit(limit + 1)

  return toPage(rows, limit)
}

/**
 * Trending: most watch time over the last 7 days.
 *
 * Reads the daily rollup rather than raw events — that table is partitioned,
 * pruned at 35 days, and far too large to aggregate on a page render.
 * Watch seconds rather than view counts, because a view is one click and watch
 * time is the thing advertisers pay against.
 */
export async function listTrending(limit = 12): Promise<VideoCard[]> {
  const since = new Date(Date.now() - 7 * 86_400_000)

  const ranked = db
    .select({
      videoId: videoStatsDaily.videoId,
      score: sql<number>`sum(${videoStatsDaily.watchSeconds})`.as('score'),
    })
    .from(videoStatsDaily)
    .where(gt(videoStatsDaily.day, since.toISOString().slice(0, 10)))
    .groupBy(videoStatsDaily.videoId)
    .as('ranked')

  const rows = await db
    .select(cardColumns)
    .from(videos)
    .innerJoin(ranked, eq(ranked.videoId, videos.id))
    .where(isLive)
    .orderBy(desc(ranked.score))
    .limit(limit)

  // A brand-new library has no stats yet, and an empty trending rail on the
  // homepage looks broken rather than new.
  if (rows.length === 0) return (await listLatest(limit)).items

  return withAssetUrls(rows)
}

export async function listByCategory(
  categorySlug: string,
  limit = 24,
  cursor: Cursor = null,
): Promise<Page<VideoCard>> {
  const rows = await db
    .select(cardColumns)
    .from(videos)
    .innerJoin(videoCategories, eq(videoCategories.videoId, videos.id))
    .innerJoin(categories, eq(categories.id, videoCategories.categoryId))
    .where(and(isLive, eq(categories.slug, categorySlug), olderThan(cursor)))
    .orderBy(desc(videos.publishedAt), desc(videos.id))
    .limit(limit + 1)

  return toPage(rows, limit)
}

export async function getCategory(slug: string) {
  const [row] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1)
  return row ?? null
}

export async function listCategories() {
  return db.select().from(categories).orderBy(categories.sortOrder)
}

/** Categories that actually have published videos, for the homepage rails. */
export async function listCategoriesWithVideos(limit = 6) {
  return db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      count: sql<number>`count(${videos.id})::int`,
    })
    .from(categories)
    .innerJoin(videoCategories, eq(videoCategories.categoryId, categories.id))
    .innerJoin(videos, and(eq(videos.id, videoCategories.videoId), isLive))
    .groupBy(categories.id, categories.slug, categories.name, categories.sortOrder)
    .orderBy(categories.sortOrder)
    .limit(limit)
}

export async function getVideoBySlug(slug: string) {
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.slug, slug), isNull(videos.deletedAt)))
    .limit(1)

  if (!video) return null

  const variants = await db
    .select()
    .from(videoVariants)
    .where(eq(videoVariants.videoId, video.id))
    .orderBy(videoVariants.height)

  const cats = await db
    .select({ slug: categories.slug, name: categories.name })
    .from(categories)
    .innerJoin(videoCategories, eq(videoCategories.categoryId, categories.id))
    .where(eq(videoCategories.videoId, video.id))

  const provider = await getVideoProvider()
  const url = (path: string | null) => (path ? provider.publicUrl(path) : null)

  return {
    ...video,
    posterUrl: url(video.posterUrl),
    portraitUrl: url(video.portraitUrl),
    previewUrl: url(video.previewUrl),
    spriteUrl: url(video.spriteUrl),
    spriteVttUrl: url(video.spriteVttUrl),
    variants,
    categories: cats,
  }
}

/**
 * Related videos for the watch page.
 *
 * Same categories first, newest elsewhere as filler. Plan §7 v2 calls for
 * item-to-item collaborative filtering, which needs watch data this platform
 * does not have yet — shipping shared-category now beats shipping an empty rail
 * and a recommender trained on nothing.
 */
export async function listRelated(videoId: string, limit = 12): Promise<VideoCard[]> {
  const cats = await db
    .select({ categoryId: videoCategories.categoryId })
    .from(videoCategories)
    .where(eq(videoCategories.videoId, videoId))

  const related =
    cats.length > 0
      ? await db
          .selectDistinct(cardColumns)
          .from(videos)
          .innerJoin(videoCategories, eq(videoCategories.videoId, videos.id))
          .where(
            and(
              isLive,
              ne(videos.id, videoId),
              inArray(
                videoCategories.categoryId,
                cats.map((c) => c.categoryId),
              ),
            ),
          )
          .orderBy(desc(videos.publishedAt))
          .limit(limit)
      : []

  if (related.length >= limit) return withAssetUrls(related)

  const seen = new Set([videoId, ...related.map((r) => r.id)])
  const filler = (await listLatest(limit)).items.filter((v) => !seen.has(v.id))

  return [...(await withAssetUrls(related)), ...filler].slice(0, limit)
}

/**
 * Full-text search over title and description.
 *
 * Postgres FTS against the generated `search_vector` column, not Meilisearch.
 * Plan §4 specifies Meilisearch for typo tolerance, and it is the right answer
 * once the library is large — but it is another service to run and back up, and
 * `websearch_to_tsquery` over a few thousand rows returns in single-digit
 * milliseconds. Swap when result quality actually becomes the complaint.
 *
 * `simple` config, matching the column: there is no Hindi or Gujarati stemmer,
 * and English stemming makes transliterated titles worse.
 */
export async function searchVideos(
  query: string,
  limit = 24,
  cursor: Cursor = null,
): Promise<Page<VideoCard>> {
  const trimmed = query.trim()
  if (!trimmed) return { items: [], nextCursor: null }

  const tsquery = sql`websearch_to_tsquery('simple', ${trimmed})`

  const rows = await db
    .select(cardColumns)
    .from(videos)
    .where(and(isLive, sql`${videos.searchVector} @@ ${tsquery}`, olderThan(cursor)))
    .orderBy(
      // Relevance first, then recency as the tiebreaker.
      desc(sql`ts_rank(${videos.searchVector}, ${tsquery})`),
      desc(videos.publishedAt),
      desc(videos.id),
    )
    .limit(limit + 1)

  return toPage(rows, limit)
}

/** Autocomplete. Prefix match rather than FTS, which cannot match a partial word. */
export async function suggest(prefix: string, limit = 8) {
  const trimmed = prefix.trim()
  if (trimmed.length < 2) return []

  const rows = await db
    .select({ slug: videos.slug, title: videos.title, posterUrl: videos.posterUrl })
    .from(videos)
    .where(and(isLive, sql`${videos.title} ILIKE ${`%${trimmed}%`}`))
    .orderBy(desc(videos.viewCount))
    .limit(limit)

  return withAssetUrls(rows)
}
