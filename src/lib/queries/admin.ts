import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'

import {
  auditLog,
  categories,
  db,
  jobs,
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
    entityType: 'video' | 'category' | 'job'
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
