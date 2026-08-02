import { and, desc, eq, sql } from 'drizzle-orm'

import { db, videos, watchHistory } from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'
import { getVideoProvider } from '@/lib/video'

/**
 * Continue Watching.
 *
 * Lives here rather than inline in the route handler, like every other read
 * query, so it can be exercised without a request context. That is not
 * housekeeping: the band filter below is raw SQL, a type error inside it
 * answered 500 on every read in production, and nothing that typechecks would
 * have caught it. Only running the query does — see scripts/check-history.ts.
 */

/**
 * When a title belongs on the rail.
 *
 * The lower bound is the smaller of an absolute floor and a fraction of the
 * runtime, not the floor alone. A flat 15s is right for a 24-minute episode and
 * incoherent for a two-minute music video or an AMV, both of which are
 * top-level categories here. Under a flat floor anything shorter than ~16s has
 * an *empty* band — every position clearing the floor is at or past the end, so
 * the title is at once "far enough in to resume" and "finished", and can never
 * appear. Scaling the floor down for short content keeps the band non-empty at
 * every runtime.
 */
export const MIN_RESUME_SECONDS = 15
export const MIN_RESUME_FRACTION = 0.05
export const COMPLETE_FRACTION = 0.95

export type ContinueWatchingItem = {
  id: string
  slug: string
  title: string
  posterUrl: string | null
  portraitUrl: string | null
  durationSec: number | null
  ageRating: string
  hasSub: boolean
  hasDub: boolean
  seasonLabel: string | null
  score: number | null
  positionSec: number
  watchedAt: Date
  progress: number
}

export async function listContinueWatching(
  userId: string,
  limit = 20,
): Promise<ContinueWatchingItem[]> {
  const rows = await db
    .select({
      id: videos.id,
      slug: videos.slug,
      title: videos.title,
      posterUrl: videos.posterUrl,
      portraitUrl: videos.portraitUrl,
      durationSec: videos.durationSec,
      ageRating: videos.ageRating,
      hasSub: videos.hasSub,
      hasDub: videos.hasDub,
      seasonLabel: videos.seasonLabel,
      score: videos.score,
      positionSec: watchHistory.positionSec,
      watchedAt: watchHistory.watchedAt,
    })
    .from(watchHistory)
    .innerJoin(videos, eq(videos.id, watchHistory.videoId))
    .where(
      and(
        eq(watchHistory.userId, userId),
        eq(watchHistory.completed, false),
        publiclyVisible,
        /**
         * Every parameter is cast explicitly.
         *
         * Without the casts `coalesce(duration_sec, $n)` resolves $n to integer
         * from its sibling, and the fraction then reaches Postgres as an
         * integer literal — "invalid input syntax for type integer: 0.05", a
         * 500 on every read. Drizzle sends these as untyped parameters, so the
         * type has to be stated here.
         */
        sql`${watchHistory.positionSec} >= least(
              ${MIN_RESUME_SECONDS}::numeric,
              coalesce(${videos.durationSec}::numeric, ${MIN_RESUME_SECONDS}::numeric)
                * ${MIN_RESUME_FRACTION}::numeric
            )`,
      ),
    )
    .orderBy(desc(watchHistory.watchedAt))
    .limit(limit)

  const provider = await getVideoProvider()

  return rows.map((row) => ({
    ...row,
    posterUrl: row.posterUrl ? provider.publicUrl(row.posterUrl) : null,
    portraitUrl: row.portraitUrl ? provider.publicUrl(row.portraitUrl) : null,
    progress: row.durationSec ? Math.min(1, row.positionSec / row.durationSec) : 0,
  }))
}

/**
 * Recently watched titles, including finished ones.
 *
 * `listContinueWatching` is the resume rail — it hides anything past the
 * 95% mark and anything below the resume floor. The account dashboard wants
 * the full recency stream: a title a viewer finished last night belongs there
 * even though it does not belong on the resume rail, and a title they
 * scrubbed past the floor but did not finish belongs on the resume rail and
 * here alike. Hence a separate read rather than a flag on the existing one.
 *
 * `completed` is returned so the dashboard can mark a finished row without
 * re-deriving it from the progress fraction (the catalogue duration could be
 * null for a video still transcoding, and the band filter above is the only
 * thing keeping a 100%-of-unknown-duration row honest).
 */
export type RecentHistoryItem = ContinueWatchingItem & {
  completed: boolean
}

export async function listRecentHistory(
  userId: string,
  limit = 20,
): Promise<RecentHistoryItem[]> {
  const rows = await db
    .select({
      id: videos.id,
      slug: videos.slug,
      title: videos.title,
      posterUrl: videos.posterUrl,
      portraitUrl: videos.portraitUrl,
      durationSec: videos.durationSec,
      ageRating: videos.ageRating,
      hasSub: videos.hasSub,
      hasDub: videos.hasDub,
      seasonLabel: videos.seasonLabel,
      score: videos.score,
      positionSec: watchHistory.positionSec,
      watchedAt: watchHistory.watchedAt,
      completed: watchHistory.completed,
    })
    .from(watchHistory)
    .innerJoin(videos, eq(videos.id, watchHistory.videoId))
    .where(and(eq(watchHistory.userId, userId), publiclyVisible))
    .orderBy(desc(watchHistory.watchedAt))
    .limit(limit)

  const provider = await getVideoProvider()

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    posterUrl: row.posterUrl ? provider.publicUrl(row.posterUrl) : null,
    portraitUrl: row.portraitUrl ? provider.publicUrl(row.portraitUrl) : null,
    durationSec: row.durationSec,
    ageRating: row.ageRating,
    hasSub: row.hasSub,
    hasDub: row.hasDub,
    seasonLabel: row.seasonLabel,
    score: row.score,
    positionSec: row.positionSec,
    watchedAt: row.watchedAt,
    completed: row.completed,
    progress: row.durationSec ? Math.min(1, row.positionSec / row.durationSec) : 0,
  }))
}

/**
 * Record a playback position.
 *
 * The catalogue duration wins over whatever the client reported. GET computes
 * `progress` from `videos.duration_sec`, so deciding `completed` from the
 * client's number lets the two disagree: a client reporting a short duration
 * marks a row complete nowhere near the end, and one reporting a long duration
 * pins a card at 100% that can never be dismissed, because the position needed
 * to clear it does not exist. The client's value is only a fallback for rows
 * whose duration was never recorded — a video still transcoding.
 *
 * Upserts on (user_id, video_id). Without that key every heartbeat would insert
 * a new row and the rail would read whichever happened to sort first.
 */
export async function recordPosition(input: {
  userId: string
  videoId: string
  positionSec: number
  clientDurationSec: number
}): Promise<'recorded' | 'unknown_video'> {
  const [video] = await db
    .select({ durationSec: videos.durationSec })
    .from(videos)
    .where(eq(videos.id, input.videoId))
    .limit(1)

  if (!video) return 'unknown_video'

  const duration = video.durationSec ?? input.clientDurationSec
  // Clamped so a malformed client cannot park a row past its own runtime.
  const positionSec = Math.min(input.positionSec, duration)
  const completed = positionSec / duration >= COMPLETE_FRACTION

  await db
    .insert(watchHistory)
    .values({
      userId: input.userId,
      videoId: input.videoId,
      positionSec,
      completed,
      watchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [watchHistory.userId, watchHistory.videoId],
      set: {
        positionSec: sql`excluded.position_sec`,
        completed: sql`excluded.completed`,
        watchedAt: sql`excluded.watched_at`,
      },
    })

  return 'recorded'
}
