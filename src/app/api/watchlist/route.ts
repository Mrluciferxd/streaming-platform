import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, videos, watchlist } from '@/db'
import { getSessionUser } from '@/lib/auth/session'
import { getVideoProvider } from '@/lib/video'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ videoId: z.uuid() })

/** The signed-in viewer's list. */
export async function GET() {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 })

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
      addedAt: watchlist.addedAt,
    })
    .from(watchlist)
    .innerJoin(videos, eq(videos.id, watchlist.videoId))
    .where(and(eq(watchlist.userId, user.id), eq(videos.status, 'published')))
    .orderBy(desc(watchlist.addedAt))
    .limit(200)

  // Stored paths are bucket-relative; the provider turns them into URLs.
  const provider = await getVideoProvider()
  const items = rows.map((row) => ({
    ...row,
    posterUrl: row.posterUrl ? provider.publicUrl(row.posterUrl) : null,
    portraitUrl: row.portraitUrl ? provider.publicUrl(row.portraitUrl) : null,
  }))

  return Response.json({ items }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  // Idempotent: pressing the button twice, or a retried request, must not
  // error. The primary key on (user_id, video_id) makes that a no-op.
  await db
    .insert(watchlist)
    .values({ userId: user.id, videoId: parsed.data.videoId })
    .onConflictDoNothing()

  return Response.json({ ok: true, inList: true })
}

export async function DELETE(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  await db
    .delete(watchlist)
    .where(and(eq(watchlist.userId, user.id), eq(watchlist.videoId, parsed.data.videoId)))

  return Response.json({ ok: true, inList: false })
}
