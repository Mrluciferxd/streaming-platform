import { and, eq, sql } from 'drizzle-orm'

import { db, reactions, videos } from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'

export type ReactionType = 'like' | 'dislike'
export type ReactionCounts = { likes: number; dislikes: number; mine: ReactionType | null }

/**
 * Like/dislike on a title.
 *
 * One row per (user, video). A second tap on the same type clears the
 * reaction; a tap on the opposite type flips it. The `reactions` table has a
 * primary key on `(user_id, video_id)` plus an enum `type` column, so a
 * flip is an UPDATE (not a delete+insert) and a clear is a DELETE.
 */

/**
 * Counts + the caller's own reaction (or null when signed-out / no reaction).
 *
 * Anonymous viewers get the same counts as signed-in ones — the like count is
 * what makes a title attractive — they just can't change it.
 */
export async function getReactionCounts(videoId: string): Promise<ReactionCounts> {
  // Two cheap count queries rather than a GROUP BY: the partial index
  // reactions_video_idx on (video_id, type) covers each, and a GROUP BY would
  // still have to read the same pages without the planner being able to use
  // the index for both sides at once.
  const [likeRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reactions)
    .where(and(eq(reactions.videoId, videoId), eq(reactions.type, 'like')))
    .limit(1)

  const [dislikeRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reactions)
    .where(and(eq(reactions.videoId, videoId), eq(reactions.type, 'dislike')))
    .limit(1)

  return {
    likes: likeRow?.count ?? 0,
    dislikes: dislikeRow?.count ?? 0,
    mine: null,
  }
}

/** The signed-in viewer's reaction to a video, or null if none. */
export async function getUserReaction(userId: string, videoId: string): Promise<ReactionType | null> {
  const [row] = await db
    .select({ type: reactions.type })
    .from(reactions)
    .where(and(eq(reactions.userId, userId), eq(reactions.videoId, videoId)))
    .limit(1)

  return row?.type ?? null
}

/**
 * Set or change a reaction. Returns the new state.
 *
 * Switching like -> dislike is an UPDATE on the existing row: the (user_id,
 * video_id) primary key conflict target is the same, type is overwritten.
 */
export async function setReaction(
  userId: string,
  videoId: string,
  type: ReactionType,
): Promise<ReactionType> {
  await db
    .insert(reactions)
    .values({ userId, videoId, type })
    .onConflictDoUpdate({
      target: [reactions.userId, reactions.videoId],
      set: { type },
    })

  return type
}

/** Remove the viewer's reaction (a second tap on the same type). */
export async function clearReaction(userId: string, videoId: string): Promise<void> {
  await db
    .delete(reactions)
    .where(and(eq(reactions.userId, userId), eq(reactions.videoId, videoId)))
}

/**
 * Guard for both POST and DELETE: the video must exist and be publicly
 * visible. Ratings on an unpublished or taken-down video are not a thing.
 */
export async function videoIsRatable(videoId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: videos.id })
    .from(videos)
    .where(and(eq(videos.id, videoId), publiclyVisible))
    .limit(1)
  return Boolean(row)
}
