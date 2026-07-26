import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db, videos, watchHistory } from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'
import { getSessionUser } from '@/lib/auth/session'
import { getVideoProvider } from '@/lib/video'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  videoId: z.uuid(),
  positionSec: z.number().int().min(0).max(86_400),
  durationSec: z.number().int().min(1).max(86_400),
})

/** Below this a viewer barely started; above the tail they effectively finished. */
const MIN_RESUME_SECONDS = 15
const COMPLETE_FRACTION = 0.95

/**
 * Continue Watching.
 *
 * Only titles genuinely in progress: a video watched for eight seconds is not
 * something to resume, and one watched to 96% is finished. Returning either
 * fills the rail with rows nobody wants to click, which is the usual way this
 * feature stops being used.
 */
export async function GET() {
  const user = await getSessionUser()
  if (!user) return Response.json({ items: [] }, { headers: { 'Cache-Control': 'private, no-store' } })

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
        eq(watchHistory.userId, user.id),
        eq(watchHistory.completed, false),
        publiclyVisible,
        sql`${watchHistory.positionSec} >= ${MIN_RESUME_SECONDS}`,
      ),
    )
    .orderBy(desc(watchHistory.watchedAt))
    .limit(20)

  const provider = await getVideoProvider()
  const items = rows.map((row) => ({
    ...row,
    posterUrl: row.posterUrl ? provider.publicUrl(row.posterUrl) : null,
    portraitUrl: row.portraitUrl ? provider.publicUrl(row.portraitUrl) : null,
    progress: row.durationSec ? Math.min(1, row.positionSec / row.durationSec) : 0,
  }))

  return Response.json({ items }, { headers: { 'Cache-Control': 'private, no-store' } })
}

/**
 * Record a playback position.
 *
 * Upsert on (user_id, video_id) — the primary key added in Phase 1 exists for
 * exactly this. Without it every heartbeat would insert a new row and Continue
 * Watching would read whichever one happened to sort first.
 */
export async function POST(request: Request) {
  const user = await getSessionUser()
  // Anonymous viewers keep their positions in localStorage instead; this is not
  // an error, and returning one would make the player log noise on every tick.
  if (!user) return new Response(null, { status: 204 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  const { videoId, positionSec, durationSec } = parsed.data

  /**
   * The catalogue duration wins over whatever the client reported.
   *
   * GET computes `progress` from `videos.duration_sec` while this handler was
   * deciding `completed` from the client's number. Those disagreeing is not
   * hypothetical — a client that reports a short duration marks the row
   * complete at a position that is nowhere near the end, and one that reports a
   * long duration leaves a card pinned at 100% in Continue Watching that can
   * never be dismissed, because the position needed to clear it does not exist.
   *
   * Deriving both from the same authority removes the disagreement. The
   * client's value is only a fallback for rows whose duration was never
   * recorded (a video still transcoding), and the position is clamped so a
   * malformed client cannot park a row past its own runtime.
   */
  const [video] = await db
    .select({ durationSec: videos.durationSec })
    .from(videos)
    .where(eq(videos.id, videoId))
    .limit(1)

  if (!video) return new Response(null, { status: 204 })

  const authoritativeDuration = video.durationSec ?? durationSec
  const clampedPosition = Math.min(positionSec, authoritativeDuration)
  const completed = clampedPosition / authoritativeDuration >= COMPLETE_FRACTION

  await db
    .insert(watchHistory)
    .values({
      userId: user.id,
      videoId,
      positionSec: clampedPosition,
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

  return new Response(null, { status: 204 })
}
