import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import {
  auditLog,
  categories,
  db,
  episodes,
  jobs,
  series,
  users,
  videoCategories,
  videoRetention,
  videos,
  videoStatsDaily,
  videoVariants,
} from '@/db'
import type { Executor } from '@/lib/jobs/queue'
import { getVideoProvider } from '@/lib/video'

/**
 * Reads and audit writes for the operator surface.
 *
 * Separate from queries/videos.ts because the two have opposite requirements.
 * The public queries never see anything but `published AND deleted_at IS NULL`
 * and page by keyset; the admin queries exist precisely to show the rows the
 * public ones hide — drafts, failures, takedowns — and page by number, because
 * an operator scanning a library wants "page 4", not an infinite scroll they
 * cannot get back to.
 *
 * OFFSET is fine here for the same reason it is banned there: the public list
 * is paged by tens of thousands of viewers with unbounded depth, this one by a
 * handful of operators who stop after a few screens.
 */

export type VideoStatus = (typeof videos.status.enumValues)[number]
export type AgeRating = (typeof videos.ageRating.enumValues)[number]

export const VIDEO_STATUSES = videos.status.enumValues
export const AGE_RATINGS = videos.ageRating.enumValues

/** IT Rules 2021 wording, so the operator picks a rating rather than a letter. */
export const AGE_RATING_LABELS: Record<AgeRating, string> = {
  U: 'U — universal',
  UA7: 'U/A 7+ — parental guidance under 7',
  UA13: 'U/A 13+ — parental guidance under 13',
  UA16: 'U/A 16+ — parental guidance under 16',
  A: 'A — adults only',
}

export type TranscodeJobView = {
  id: number
  status: (typeof jobs.status.enumValues)[number]
  progress: number
  attempts: number
  maxAttempts: number
  lastError: string | null
  runAt: Date
  updatedAt: Date
}

export type AdminVideoRow = {
  id: string
  slug: string
  title: string
  status: VideoStatus
  ageRating: AgeRating
  language: string
  durationSec: number | null
  viewCount: number
  posterUrl: string | null
  hasSub: boolean
  hasDub: boolean
  seasonLabel: string | null
  publishedAt: Date | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  uploaderName: string | null
  job: TranscodeJobView | null
}

export type AdminVideoFilter = {
  /** A `videos.status` value, 'deleted' for soft-deleted rows, or undefined for all live rows. */
  status?: VideoStatus | 'deleted'
  query?: string
  language?: string
  page?: number
  perPage?: number
}

export type AdminVideoPage = {
  rows: AdminVideoRow[]
  total: number
  page: number
  perPage: number
  pageCount: number
}

function videoFilterPredicate(filter: AdminVideoFilter) {
  const clauses = [
    filter.status === 'deleted'
      ? isNotNull(videos.deletedAt)
      : filter.status
        ? and(eq(videos.status, filter.status), isNull(videos.deletedAt))
        : isNull(videos.deletedAt),
  ]

  // ILIKE rather than the FTS vector: an operator looking for a title usually
  // has a fragment of it ("gash" for "Gashira"), and `websearch_to_tsquery`
  // cannot match a partial word. The library is small enough for a seq scan.
  if (filter.query?.trim()) clauses.push(sql`${videos.title} ILIKE ${`%${filter.query.trim()}%`}`)
  if (filter.language) clauses.push(eq(videos.language, filter.language))

  return and(...clauses)
}

export async function listAdminVideos(filter: AdminVideoFilter = {}): Promise<AdminVideoPage> {
  const perPage = Math.min(Math.max(filter.perPage ?? 25, 5), 100)
  const page = Math.max(filter.page ?? 1, 1)
  const where = videoFilterPredicate(filter)

  const [totalRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(videos)
    .where(where)

  const total = totalRow?.total ?? 0

  const rows = await db
    .select({
      id: videos.id,
      slug: videos.slug,
      title: videos.title,
      status: videos.status,
      ageRating: videos.ageRating,
      language: videos.language,
      durationSec: videos.durationSec,
      viewCount: videos.viewCount,
      posterUrl: videos.posterUrl,
      hasSub: videos.hasSub,
      hasDub: videos.hasDub,
      seasonLabel: videos.seasonLabel,
      publishedAt: videos.publishedAt,
      createdAt: videos.createdAt,
      updatedAt: videos.updatedAt,
      deletedAt: videos.deletedAt,
      uploaderName: users.displayName,
    })
    .from(videos)
    .leftJoin(users, eq(users.id, videos.uploaderId))
    .where(where)
    .orderBy(desc(videos.updatedAt), desc(videos.id))
    .limit(perPage)
    .offset((page - 1) * perPage)

  const jobsByVideo = await latestTranscodeJobs(rows.map((r) => r.id))
  const provider = await getVideoProvider()

  return {
    rows: rows.map((row) => ({
      ...row,
      posterUrl: row.posterUrl ? provider.publicUrl(row.posterUrl) : null,
      job: jobsByVideo.get(row.id) ?? null,
    })),
    total,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
  }
}

/** Row counts per status, for the filter bar. One grouped scan, not nine counts. */
export async function videoStatusCounts(): Promise<Record<string, number>> {
  const live = await db
    .select({ status: videos.status, count: sql<number>`count(*)::int` })
    .from(videos)
    .where(isNull(videos.deletedAt))
    .groupBy(videos.status)

  const [deleted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(videos)
    .where(isNotNull(videos.deletedAt))

  return {
    ...Object.fromEntries(live.map((r) => [r.status, r.count])),
    deleted: deleted?.count ?? 0,
  }
}

/**
 * Latest transcode job per video.
 *
 * The job's video lives in the jsonb payload rather than a column, so this
 * cannot use an index — acceptable only because `jobs` is pruned to a few days
 * of history and a page is 25 videos. If the table ever grows, promote
 * `payload->>'videoId'` to a generated column with an index rather than
 * widening this query.
 */
async function latestTranscodeJobs(videoIds: string[]): Promise<Map<string, TranscodeJobView>> {
  const found = new Map<string, TranscodeJobView>()
  if (videoIds.length === 0) return found

  const idList = sql.join(
    videoIds.map((id) => sql`${id}`),
    sql`, `,
  )

  const rows = await db
    .select({
      videoId: sql<string>`${jobs.payload}->>'videoId'`,
      id: jobs.id,
      status: jobs.status,
      progress: jobs.progress,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      lastError: jobs.lastError,
      runAt: jobs.runAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .where(and(eq(jobs.kind, 'transcode'), sql`${jobs.payload}->>'videoId' IN (${idList})`))
    .orderBy(desc(jobs.id))

  // Descending id, so the first row seen for a video is its newest job.
  for (const row of rows) {
    if (!found.has(row.videoId)) {
      const { videoId: _videoId, ...job } = row
      found.set(row.videoId, job)
    }
  }

  return found
}

export type AdminVideoDetail = Awaited<ReturnType<typeof getAdminVideo>>

export async function getAdminVideo(id: string) {
  const [video] = await db.select().from(videos).where(eq(videos.id, id)).limit(1)
  if (!video) return null

  const [assigned, variants, job, uploader] = await Promise.all([
    db
      .select({ categoryId: videoCategories.categoryId })
      .from(videoCategories)
      .where(eq(videoCategories.videoId, id)),
    db
      .select()
      .from(videoVariants)
      .where(eq(videoVariants.videoId, id))
      .orderBy(asc(videoVariants.height)),
    latestTranscodeJobs([id]).then((m) => m.get(id) ?? null),
    video.uploaderId
      ? db
          .select({ displayName: users.displayName, email: users.email })
          .from(users)
          .where(eq(users.id, video.uploaderId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ])

  const provider = await getVideoProvider()
  const url = (path: string | null) => (path ? provider.publicUrl(path) : null)

  return {
    // The raw row keeps bucket-relative paths, because the editor writes paths
    // back. Resolved URLs are additive and preview-only — writing one of these
    // into the database is exactly the provider lock-in the path rule prevents.
    ...video,
    previews: {
      poster: url(video.posterUrl),
      portrait: url(video.portraitUrl),
      preview: url(video.previewUrl),
    },
    categoryIds: assigned.map((c) => c.categoryId),
    variants,
    job,
    uploader,
  }
}

/**
 * Did this error come from a specific unique index?
 *
 * Matching on the message does not work: drizzle wraps the driver error and its
 * own message is the SQL text, so the constraint name never appears in it. The
 * real PostgresError — SQLSTATE 23505 with `constraint_name` — is on `cause`.
 * Getting this wrong turns "that slug is taken" into a 500.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error

  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown }
    if (candidate.code === '23505' && candidate.constraint_name === constraint) return true
    current = candidate.cause
  }

  return false
}

/**
 * Titles for a set of ids.
 *
 * The dead-letter queue only knows a job's `payload->>'videoId'`, and "job 412
 * failed" is not something an operator can act on. One extra query turns the
 * whole page into names.
 */
export async function videoTitles(
  ids: string[],
): Promise<Map<string, { title: string; slug: string }>> {
  const found = new Map<string, { title: string; slug: string }>()
  if (ids.length === 0) return found

  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )

  const rows = await db
    .select({ id: videos.id, title: videos.title, slug: videos.slug })
    .from(videos)
    .where(sql`${videos.id} IN (${idList})`)

  for (const row of rows) found.set(row.id, { title: row.title, slug: row.slug })
  return found
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type AdminCategory = {
  id: string
  slug: string
  name: string
  description: string | null
  icon: string | null
  sortOrder: number
  videoCount: number
}

export async function listAdminCategories(): Promise<AdminCategory[]> {
  return db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      icon: categories.icon,
      sortOrder: categories.sortOrder,
      // Every assignment, not just the published ones: this number is the
      // blast radius of deleting the category, and the cascade does not care
      // whether a video is live.
      videoCount: sql<number>`count(${videoCategories.videoId})::int`,
    })
    .from(categories)
    .leftJoin(videoCategories, eq(videoCategories.categoryId, categories.id))
    .groupBy(categories.id)
    .orderBy(asc(categories.sortOrder), asc(categories.name))
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

function dayString(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

export type AnalyticsOverview = {
  since: string
  totals: {
    views: number
    watchSeconds: number
    uniqueSessions: number
    completions: number
    rebufferEvents: number
    adImpressions: number
  }
  daily: { day: string; views: number; watchSeconds: number }[]
  top: {
    videoId: string
    slug: string
    title: string
    status: VideoStatus
    views: number
    watchSeconds: number
    completions: number
  }[]
}

/**
 * Everything the dashboard shows, from `video_stats_daily`.
 *
 * Never from `video_events`: that table is partitioned, holds ~18M rows a month
 * and is pruned at 35 days. Aggregating it on a page render is the mistake the
 * rollup exists to prevent — and the rollup keeps history forever, so the
 * dashboard can look back further than the raw events ever go.
 */
export async function analyticsOverview(days = 30): Promise<AnalyticsOverview> {
  const since = dayString(days)

  const [totalsRow] = await db
    .select({
      views: sql<number>`coalesce(sum(${videoStatsDaily.views}), 0)::int`,
      watchSeconds: sql<number>`coalesce(sum(${videoStatsDaily.watchSeconds}), 0)::bigint`,
      uniqueSessions: sql<number>`coalesce(sum(${videoStatsDaily.uniqueSessions}), 0)::int`,
      completions: sql<number>`coalesce(sum(${videoStatsDaily.completions}), 0)::int`,
      rebufferEvents: sql<number>`coalesce(sum(${videoStatsDaily.rebufferEvents}), 0)::int`,
      adImpressions: sql<number>`coalesce(sum(${videoStatsDaily.adImpressions}), 0)::int`,
    })
    .from(videoStatsDaily)
    .where(gte(videoStatsDaily.day, since))

  const daily = await db
    .select({
      day: videoStatsDaily.day,
      views: sql<number>`sum(${videoStatsDaily.views})::int`,
      watchSeconds: sql<number>`sum(${videoStatsDaily.watchSeconds})::bigint`,
    })
    .from(videoStatsDaily)
    .where(gte(videoStatsDaily.day, since))
    .groupBy(videoStatsDaily.day)
    .orderBy(asc(videoStatsDaily.day))

  const top = await db
    .select({
      videoId: videos.id,
      slug: videos.slug,
      title: videos.title,
      status: videos.status,
      views: sql<number>`sum(${videoStatsDaily.views})::int`,
      watchSeconds: sql<number>`sum(${videoStatsDaily.watchSeconds})::bigint`,
      completions: sql<number>`sum(${videoStatsDaily.completions})::int`,
    })
    .from(videoStatsDaily)
    .innerJoin(videos, eq(videos.id, videoStatsDaily.videoId))
    .where(gte(videoStatsDaily.day, since))
    .groupBy(videos.id, videos.slug, videos.title, videos.status)
    .orderBy(desc(sql`sum(${videoStatsDaily.watchSeconds})`))
    .limit(10)

  return {
    since,
    totals: {
      views: Number(totalsRow?.views ?? 0),
      watchSeconds: Number(totalsRow?.watchSeconds ?? 0),
      uniqueSessions: Number(totalsRow?.uniqueSessions ?? 0),
      completions: Number(totalsRow?.completions ?? 0),
      rebufferEvents: Number(totalsRow?.rebufferEvents ?? 0),
      adImpressions: Number(totalsRow?.adImpressions ?? 0),
    },
    daily: daily.map((d) => ({
      day: d.day,
      views: Number(d.views),
      watchSeconds: Number(d.watchSeconds),
    })),
    top: top.map((t) => ({ ...t, views: Number(t.views), watchSeconds: Number(t.watchSeconds) })),
  }
}

export type RetentionPoint = { bucket: number; percent: number; sessions: number }

/**
 * Drop-off curve. Buckets are 5% of duration each, 0..20.
 *
 * Normalised against bucket 0 rather than against session count, because the
 * question an operator is asking is "where do people leave", and the absolute
 * number moves with the title's popularity. A cliff between bucket 0 and 1 is a
 * broken first segment or a mis-set poster; a slope from bucket 8 is the story
 * losing them.
 */
export async function retentionCurve(days = 30, videoId?: string): Promise<RetentionPoint[]> {
  const since = dayString(days)

  const rows = await db
    .select({
      bucket: videoRetention.bucket,
      sessions: sql<number>`sum(${videoRetention.sessions})::bigint`,
    })
    .from(videoRetention)
    .where(
      videoId
        ? and(gte(videoRetention.day, since), eq(videoRetention.videoId, videoId))
        : gte(videoRetention.day, since),
    )
    .groupBy(videoRetention.bucket)
    .orderBy(asc(videoRetention.bucket))

  const byBucket = new Map(rows.map((r) => [r.bucket, Number(r.sessions)]))
  const base = byBucket.get(0) ?? 0

  return Array.from({ length: 21 }, (_unused, bucket) => {
    const sessions = byBucket.get(bucket) ?? 0
    return { bucket, sessions, percent: base > 0 ? (sessions / base) * 100 : 0 }
  })
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'video.publish'
  | 'video.schedule'
  | 'video.unpublish'
  | 'video.update'
  | 'video.takedown'
  | 'video.delete'
  | 'video.restore'
  | 'category.create'
  | 'category.update'
  | 'category.delete'
  | 'category.reorder'
  | 'job.retry'
  | 'series.create'
  | 'series.update'
  | 'series.delete'
  | 'episode.attach'
  | 'episode.update'
  | 'episode.detach'
  | 'user.role'
  | 'user.delete'
  | 'user.restore'

/**
 * Append a row to the compliance trail.
 *
 * Takes an executor so the record can commit with the action it describes. A
 * takedown that succeeds while its audit row is lost is worse than one that
 * fails outright: when a 36-hour removal order is questioned, the answer has to
 * be a record, and "we removed it but cannot show who" is not one.
 */
export async function recordAudit(
  entry: {
    actorId: string | null
    action: AuditAction
    entityType: 'video' | 'category' | 'job' | 'series' | 'episode' | 'user'
    entityId?: string | null
    before?: unknown
    after?: unknown
    ip?: string | null
  },
  executor: Executor = db,
): Promise<void> {
  await executor.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip?.slice(0, 45) ?? null,
  })
}

export type AuditEntry = {
  id: number
  action: string
  entityType: string
  entityId: string | null
  before: unknown
  after: unknown
  ip: string | null
  createdAt: Date
  actorName: string | null
  actorEmail: string | null
}

export async function listAuditLog(
  limit = 100,
  entityId?: string,
): Promise<AuditEntry[]> {
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      before: auditLog.before,
      after: auditLog.after,
      ip: auditLog.ip,
      createdAt: auditLog.createdAt,
      actorName: users.displayName,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(entityId ? eq(auditLog.entityId, entityId) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(Math.min(limit, 500))
}

// ---------------------------------------------------------------------------
// Series and episodes
// ---------------------------------------------------------------------------

export type SeriesStatus = (typeof series.status.enumValues)[number]

export const SERIES_STATUSES = series.status.enumValues

export type AdminSeriesRow = {
  id: string
  slug: string
  title: string
  status: SeriesStatus
  totalEpisodes: number | null
  releaseYear: number | null
  seasonLabel: string | null
  studio: string | null
  episodeCount: number
  updatedAt: Date
}

/**
 * Every series row, including ones with no published episodes yet.
 *
 * `episodeCount` counts every `episodes` row, not just the published ones,
 * because the operator question here is "what is in this series" — a draft
 * episode is still attached — and the public catalogue queries already hide
 * unpublished rows from viewers.
 */
export async function listAdminSeries(): Promise<AdminSeriesRow[]> {
  const rows = await db
    .select({
      id: series.id,
      slug: series.slug,
      title: series.title,
      status: series.status,
      totalEpisodes: series.totalEpisodes,
      releaseYear: series.releaseYear,
      seasonLabel: series.seasonLabel,
      studio: series.studio,
      updatedAt: series.updatedAt,
      episodeCount: sql<number>`count(${episodes.id})::int`,
    })
    .from(series)
    .leftJoin(episodes, eq(episodes.seriesId, series.id))
    .groupBy(series.id)
    .orderBy(desc(series.updatedAt), desc(series.id))

  return rows
}

export type AdminSeriesDetail = {
  id: string
  slug: string
  title: string
  synopsis: string | null
  posterPath: string | null
  portraitPath: string | null
  bannerPath: string | null
  status: SeriesStatus
  totalEpisodes: number | null
  studio: string | null
  releaseYear: number | null
  seasonLabel: string | null
  createdAt: Date
  updatedAt: Date
}

export async function getAdminSeries(id: string): Promise<AdminSeriesDetail | null> {
  const [row] = await db.select().from(series).where(eq(series.id, id)).limit(1)
  if (!row) return null

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    synopsis: row.synopsis,
    // Bucket-relative paths kept raw: the editor writes them back, so resolving
    // to URLs here would be exactly the provider lock-in the path rule forbids.
    posterPath: row.posterUrl,
    portraitPath: row.portraitUrl,
    bannerPath: row.bannerUrl,
    status: row.status,
    totalEpisodes: row.totalEpisodes,
    studio: row.studio,
    releaseYear: row.releaseYear,
    seasonLabel: row.seasonLabel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Create a series row. Caller is responsible for the audit record. */
export async function createAdminSeries(input: {
  slug: string
  title: string
  synopsis?: string | null
  status?: SeriesStatus
  totalEpisodes?: number | null
  studio?: string | null
  releaseYear?: number | null
  seasonLabel?: string | null
}): Promise<{ id: string; slug: string }> {
  const [row] = await db
    .insert(series)
    .values({
      slug: input.slug,
      title: input.title,
      synopsis: input.synopsis?.trim() || null,
      status: input.status ?? 'airing',
      totalEpisodes: input.totalEpisodes ?? null,
      studio: input.studio?.trim() || null,
      releaseYear: input.releaseYear ?? null,
      seasonLabel: input.seasonLabel?.trim() || null,
    })
    .returning({ id: series.id, slug: series.slug })

  if (!row) throw new Error('series insert returned no row')
  return row
}

/** Patch a series row. Caller is responsible for the audit record. */
export async function updateAdminSeries(
  id: string,
  set: Partial<{
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
  }>,
): Promise<void> {
  await db.update(series).set({ ...set, updatedAt: new Date() }).where(eq(series.id, id))
}

/** Delete a series row. Caller is responsible for the audit record. */
export async function deleteAdminSeries(id: string): Promise<{ episodeCount: number }> {
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(episodes)
    .where(eq(episodes.seriesId, id))

  await db.delete(series).where(eq(series.id, id))
  // CASCADE removes episodes rows; videos rows survive, which is the point —
  // a series going away does not delete the episodes' media or watch history.

  return { episodeCount: count?.count ?? 0 }
}

// ---------------------------------------------------------------------------
// Episodes — the join rows
// ---------------------------------------------------------------------------

export type AdminEpisodeRow = {
  id: string
  videoId: string
  seriesId: string
  seasonNo: number
  episodeNo: number
  title: string | null
  synopsis: string | null
  thumbnailUrl: string | null
  airedAt: Date | null
  videoTitle: string
  videoSlug: string
  videoStatus: string
}

/** Every episode row of a series, in broadcast order, regardless of video status. */
export async function listAdminEpisodes(seriesId: string): Promise<AdminEpisodeRow[]> {
  const rows = await db
    .select({
      id: episodes.id,
      videoId: episodes.videoId,
      seriesId: episodes.seriesId,
      seasonNo: episodes.seasonNo,
      episodeNo: episodes.episodeNo,
      title: episodes.title,
      synopsis: episodes.synopsis,
      thumbnailUrl: episodes.thumbnailUrl,
      airedAt: episodes.airedAt,
      videoTitle: videos.title,
      videoSlug: videos.slug,
      videoStatus: videos.status,
    })
    .from(episodes)
    .innerJoin(videos, eq(videos.id, episodes.videoId))
    .where(eq(episodes.seriesId, seriesId))
    .orderBy(asc(episodes.seasonNo), asc(episodes.episodeNo))

  return rows
}

export type EpisodeCandidate = {
  id: string
  slug: string
  title: string
  status: string
  durationSec: number | null
  /**
   * The series this video is already attached to, if any. `null` when the video
   * is a standalone title — those are the candidates the picker shows.
   */
  attachedSeriesId: string | null
  attachedSeriesTitle: string | null
}

/**
 * Videos that can be attached as an episode of a series.
 *
 * The exclusion is by the `episodes_video_key` unique index: a video belongs to
 * at most one series, so a video with no `episodes` row is "free" and a video
 * with one means the picker should say so and grey it out rather than silently
 * move it by attaching it to a second series.
 *
 * A video already on *this* same series is excluded outright — the picker is
 * for adding new episodes, not relisting existing ones.
 *
 * `hasMedia` (an HLS master) is not required: an operator can line up an
 * episode before its transcode finishes — the public catalogue stays hidden
 * until the video is published, which is what surface it lives on.
 *
 * The "attached-to" lookup is two correlated subqueries rather than a LEFT
 * JOIN onto `episodes`, because the same `episodes` table is the very one the
 * NOT EXISTS exclusion scans — a self-alias there is awkward in Drizzle, and a
 * pair of small subqueries is also cheaper than a fan-out join a video would
 * need to deduplicate.
 */
export async function listEpisodeCandidates(
  seriesId: string,
  query?: string,
): Promise<EpisodeCandidate[]> {
  // The two scalar subqueries in the select map and the NOT EXISTS in the
  // where clause both reference the outer videos row. Drizzle's sql`` template
  // interpolates `${v.id}` as the bare `"id"` column name inside select-map
  // snippets (it does not carry the `from(v)` alias there), which is ambiguous
  // against `episodes.id` and trips SQLSTATE 42702. The where-clause
  // interpolation, by contrast, does emit the qualified `"v"."id"`. We keep
  // `${v.id}` in the NOT EXISTS (it works) but hardcode `"v"."id"` in the two
  // select subqueries where Drizzle drops the qualifier. Discovered by
  // check-series-admin; never reached by typecheck (42702 surfaces only when
  // the query actually runs against Postgres).
  const v = alias(videos, 'v')

  const clauses = [
    sql`NOT EXISTS (
      SELECT 1 FROM ${episodes} e
      WHERE e.video_id = ${v.id} AND e.series_id = ${seriesId}
    )`,
  ]

  // Soft-deleted videos are still candidates: an operator re-using a taken-down
  // video as an episode is unusual but not wrong, and the picker rendering a
  // ghost row is a clearer signal than the row simply vanishing.
  const trimmed = query?.trim()
  if (trimmed) clauses.push(sql`${v.title} ILIKE ${`%${trimmed}%`}`)

  const rows = await db
    .select({
      id: v.id,
      slug: v.slug,
      title: v.title,
      status: v.status,
      durationSec: v.durationSec,
      attachedSeriesId: sql<string | null>`(
        SELECT e.series_id FROM ${episodes} e
        WHERE e.video_id = "v"."id"
        LIMIT 1
      )`,
      // Resolved at read time rather than joined: the picker needs the title to
      // say "Already on X" and nothing else, so a second scalar subquery costs
      // less than carrying a whole series row.
      attachedSeriesTitle: sql<string | null>`(
        SELECT s.title
        FROM ${episodes} e
        JOIN ${series} s ON s.id = e.series_id
        WHERE e.video_id = "v"."id"
        LIMIT 1
      )`,
    })
    .from(v)
    .where(and(...clauses))
    .orderBy(desc(v.updatedAt))
    .limit(50)

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    durationSec: row.durationSec,
    attachedSeriesId: row.attachedSeriesId,
    attachedSeriesTitle: row.attachedSeriesTitle,
  }))
}

/** Attach a video to a series as an episode. Caller writes the audit row. */
export async function attachEpisode(input: {
  seriesId: string
  videoId: string
  seasonNo: number
  episodeNo: number
  title?: string | null
  synopsis?: string | null
  airedAt?: Date | null
}): Promise<void> {
  await db.insert(episodes).values({
    seriesId: input.seriesId,
    videoId: input.videoId,
    seasonNo: input.seasonNo,
    episodeNo: input.episodeNo,
    title: input.title?.trim() || null,
    synopsis: input.synopsis?.trim() || null,
    airedAt: input.airedAt ?? null,
  })
}

/** Patch an episode row. Caller writes the audit row. */
export async function updateEpisode(
  episodeId: string,
  set: Partial<{
    seasonNo: number
    episodeNo: number
    title: string | null
    synopsis: string | null
    airedAt: Date | null
  }>,
): Promise<void> {
  await db.update(episodes).set(set).where(eq(episodes.id, episodeId))
}

/** Detach an episode from its series. Caller writes the audit row. */
export async function detachEpisode(episodeId: string): Promise<void> {
  await db.delete(episodes).where(eq(episodes.id, episodeId))
}

/**
 * The episode a video belongs to, or null if it is a standalone title.
 *
 * Returns enough to populate the picker state in the video editor without a
 * second round trip for the series title.
 */
export async function getEpisodeForVideo(
  videoId: string,
): Promise<{ episodeId: string; seriesId: string; seriesTitle: string; seasonNo: number; episodeNo: number } | null> {
  const [row] = await db
    .select({
      episodeId: episodes.id,
      seriesId: series.id,
      seriesTitle: series.title,
      seasonNo: episodes.seasonNo,
      episodeNo: episodes.episodeNo,
    })
    .from(episodes)
    .innerJoin(series, eq(series.id, episodes.seriesId))
    .where(eq(episodes.videoId, videoId))
    .limit(1)

  return row ?? null
}

/**
 * Rewrite a series' (season, episode) ordering en masse.
 *
 * Reordering a Greek chorus is a whole-array rewrite, not pairwise swaps: the
 * new order is a sequence property, and swaps under concurrent edits race. The
 * caller provides the full ordered list of episode ids per series; this writes
 * them all in one transaction.
 *
 * Two-phase update: the `(series_id, season_no, episode_no)` triplet has a
 * UNIQUE index, so writing the final slots directly trips `episodes_series_
 * season_ep_key` mid-loop — moving E99 onto E1 collides with E1's row before
 * E1 has been moved off. Plain seasons reorder sidesteps this because
 * `categories.sort_order` is a plain integer with no unique constraint, but
 * episodes carry a real unique key, so a naive loop fails.
 *
 * Phase 1 parks every row on a throwaway `episode_no` derived from its index
 * in the new order (a band well above any episode_no the schema accepts —
 * zod caps at 9999, smallint tops out at 32767, so 30000+i is safe and
 * distinct per row), satisfying the `episode_no > 0` CHECK and keeping the
 * triplets unique while the real targets are still occupied. Phase 2 writes
 * the final `(season_no, episode_no)` now that the colliding slots are empty.
 *
 * The route wraps both phases in a single transaction and passes the `tx`
 * here, so a failure in either phase rolls every row back to its old slot.
 */
const REORDER_PARK_BAND = 30000

export async function reorderEpisodes(
  ordered: { episodeId: string; seasonNo: number; episodeNo: number }[],
  executor: Executor = db,
): Promise<void> {
  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i]
    if (!item) continue
    await executor
      .update(episodes)
      .set({ seasonNo: 1, episodeNo: REORDER_PARK_BAND + i })
      .where(eq(episodes.id, item.episodeId))
  }

  for (const item of ordered) {
    await executor
      .update(episodes)
      .set({ seasonNo: item.seasonNo, episodeNo: item.episodeNo })
      .where(eq(episodes.id, item.episodeId))
  }
}

