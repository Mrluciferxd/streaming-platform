import { z } from 'zod'

import { getSessionUser } from '@/lib/auth/session'
import {
  clearReaction,
  getReactionCounts,
  getUserReaction,
  setReaction,
  videoIsRatable,
} from '@/lib/queries/reactions'

export const dynamic = 'force-dynamic'

const querySchema = z.object({ videoId: z.uuid() })
const bodySchema = z.object({
  videoId: z.uuid(),
  type: z.enum(['like', 'dislike']),
})

/**
 * Like/dislike on a title.
 *
 * Anonymous viewers may read counts (a high like count is social proof a
 * search crawler should not gate behind a session) but cannot change them.
 * A signed-in viewer's own reaction is included in the GET response so the
 * buttons render in the right state on first paint.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({ videoId: url.searchParams.get('videoId') })
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  const counts = await getReactionCounts(parsed.data.videoId)
  const user = await getSessionUser()
  if (user) {
    counts.mine = await getUserReaction(user.id, parsed.data.videoId)
  }

  return Response.json(counts, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  if (!(await videoIsRatable(parsed.data.videoId))) {
    // 404, not 403, mirrors the operator-surface posture: revealing that a
    // ratable-but-unpublished video exists is a leak.
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  await setReaction(user.id, parsed.data.videoId, parsed.data.type)
  const counts = await getReactionCounts(parsed.data.videoId)
  counts.mine = parsed.data.type

  return Response.json(counts, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function DELETE(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 })

  const url = new URL(request.url)
  const parsed = querySchema.safeParse({ videoId: url.searchParams.get('videoId') })
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  if (!(await videoIsRatable(parsed.data.videoId))) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  await clearReaction(user.id, parsed.data.videoId)
  const counts = await getReactionCounts(parsed.data.videoId)
  counts.mine = null

  return Response.json(counts, { headers: { 'Cache-Control': 'private, no-store' } })
}
