import { and, eq, isNull, sql } from 'drizzle-orm'

import { videos } from '@/db'

/**
 * What "publicly visible" means, in one place.
 *
 * Three conditions, and the third is the one that is easy to forget: a row
 * whose `published_at` is in the future is scheduled, not live.
 *
 * Scheduling used to work around this by parking the row at `ready` and
 * relying on a cron to flip it to `published` when the time came. That made a
 * release depend on a job running — if the cron was missing, throttled, or the
 * plan did not allow it to run often enough, the title simply never appeared,
 * and nothing in the product said so. Putting the clock in the read path
 * instead means a scheduled title goes live exactly on time with no moving
 * parts, and a schedule cannot silently fail because there is nothing to fail.
 *
 * `published_at IS NULL` counts as visible so rows published before this column
 * was consistently set do not vanish.
 *
 * The partial index `videos_published_idx` still applies: `now()` is not
 * immutable so it cannot live in an index predicate, but Postgres uses the
 * index for the status/deleted_at part and applies the timestamp filter to the
 * rows it returns.
 */
export const publiclyVisible = and(
  eq(videos.status, 'published'),
  isNull(videos.deletedAt),
  sql`(${videos.publishedAt} is null or ${videos.publishedAt} <= now())`,
)

export type VisibilityRow = {
  status: string
  deletedAt: Date | null
  publishedAt: Date | null
}

/**
 * The same rule for a row already in hand, so the watch page and the playback
 * endpoint cannot drift from the list queries.
 */
export function isPubliclyVisible(video: VisibilityRow): boolean {
  if (video.status !== 'published') return false
  if (video.deletedAt) return false

  return video.publishedAt === null || video.publishedAt.getTime() <= Date.now()
}
