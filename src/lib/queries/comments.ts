import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'

import { comments, db, users, videos } from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'

/**
 * Comments on a video.
 *
 * One level of threading — a top-level comment, and any replies to it
 * — rather than an arbitrary-depth tree. Two queries are used because the
 * `comments_parent_idx` covers a directed lookup cheaply, and assembling in
 * Node keeps the SQL readable. Arbitrary depth has been judged not worth
 * it: most replies are direct answers, and a deeper tree could carry a
 * moderator's deletion-burden well past any viewer value on this kind of
 * site.
 */

export type CommentRow = {
  id: string
  videoId: string
  body: string
  createdAt: Date
  authorDisplayName: string
  authorRole: string
  /** Replies are themselves CommentRow-shaped (no further nesting). */
  replies: CommentRow[]
}

export async function listComments(videoId: string): Promise<CommentRow[]> {
  // Top-level visible comments, newest first. The partial index
  // comments_video_idx covers this.
  const tops = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      authorDisplayName: users.displayName,
      authorRole: users.role,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.userId))
    .where(and(eq(comments.videoId, videoId), eq(comments.status, 'visible'), isNull(comments.parentId)))
    .orderBy(desc(comments.createdAt))

  if (tops.length === 0) return []

  const topIds = tops.map((t) => t.id)

  // Replies to any of those tops, oldest-first so a thread reads naturally.
  // `inArray` binds the JS array as a proper `= ANY($1::uuid[])` parameter —
  // a raw `sql\`...\` template passes the array as a single string and trips
  // Postgres 22P02 "malformed array literal". `topIds` is never empty here
  // (the early-return above), and `inArray(col, [])` is itself unsafe in
  // Drizzle, so the guard is load-bearing.
  const replies = await db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      body: comments.body,
      createdAt: comments.createdAt,
      authorDisplayName: users.displayName,
      authorRole: users.role,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.userId))
    .where(and(eq(comments.videoId, videoId), eq(comments.status, 'visible'), inArray(comments.parentId, topIds)))
    .orderBy(asc(comments.createdAt))

  // Group replies under their top. A Map keeps this O(replies).
  const byParent = new Map<string, CommentRow[]>()
  for (const r of replies) {
    const parentId = r.parentId
    if (!parentId) continue
    const bucket = byParent.get(parentId) ?? []
    bucket.push({
      id: r.id,
      videoId,
      body: r.body,
      createdAt: r.createdAt,
      authorDisplayName: r.authorDisplayName ?? 'Deleted account',
      authorRole: r.authorRole ?? 'viewer',
      replies: [],
    })
    byParent.set(parentId, bucket)
  }

  return tops.map((t) => ({
    id: t.id,
    videoId,
    body: t.body,
    createdAt: t.createdAt,
    authorDisplayName: t.authorDisplayName ?? 'Deleted account',
    authorRole: t.authorRole ?? 'viewer',
    replies: byParent.get(t.id) ?? [],
  }))
}

/**
 * Post a comment. Top-level if `parentId` is null, a reply otherwise. Both
 * default to `visible` — moderation status (`pending`, `hidden`, `deleted`)
 * is reserved for the moderation surface and is never set by the viewer.
 */
export async function createComment(input: {
  videoId: string
  userId: string
  parentId?: string | null
  body: string
}): Promise<{ id: string; ok: true }> {
  const [row] = await db
    .insert(comments)
    .values({
      videoId: input.videoId,
      userId: input.userId,
      parentId: input.parentId ?? null,
      body: input.body,
      status: 'visible',
    })
    .returning({ id: comments.id })

  if (!row) throw new Error('insert returned no row')
  return { id: row.id, ok: true }
}

/**
 * Guard: the video must be published to be commented on. A takedown must
 * not leave a thread alive on a video the public can no longer see.
 */
export async function videoIsCommentable(videoId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: videos.id })
    .from(videos)
    .where(and(eq(videos.id, videoId), publiclyVisible))
    .limit(1)
  return Boolean(row)
}
