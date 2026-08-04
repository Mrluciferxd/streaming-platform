import { z } from 'zod'

import { getSessionUser } from '@/lib/auth/session'
import { createComment, listComments, videoIsCommentable } from '@/lib/queries/comments'

export const dynamic = 'force-dynamic'

const querySchema = z.object({ videoId: z.uuid() })
const bodySchema = z.object({
  videoId: z.uuid(),
  body: z.string().trim().min(1).max(20_000),
  parentId: z.uuid().nullable().optional(),
})

/**
 * Per-video comment thread, one level deep.
 *
 * Anonymous viewers can read (comments are part of the discoverable surface —
 * a lively thread is social proof, and it is what a search engine picks up).
 * Posting requires a session; rate-limiting on the heartbeat budget already
 * covers comment spam at the IP layer.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({ videoId: url.searchParams.get('videoId') })
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  const items = await listComments(parsed.data.videoId)
  return Response.json(
    { items },
    { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=600' } },
  )
}

export async function POST(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  if (!(await videoIsCommentable(parsed.data.videoId))) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  // If parentId is provided it must be a top-level comment on the same
  // video. A reply to a reply is rejected here (the schema allows arbitrary
  // depth but the UI is one-level by design) — keeps the thread readable
  // and avoids orphaning a reply under a comment the moderator later hides.
  if (parsed.data.parentId) {
    const validParent = await listComments(parsed.data.videoId).then((items) =>
      items.some((t) => t.id === parsed.data.parentId),
    )
    if (!validParent) return Response.json({ error: 'invalid_parent' }, { status: 400 })
  }

  const result = await createComment({
    videoId: parsed.data.videoId,
    userId: user.id,
    parentId: parsed.data.parentId ?? null,
    body: parsed.data.body,
  })

  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
