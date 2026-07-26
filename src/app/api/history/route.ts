import { z } from 'zod'

import { getSessionUser } from '@/lib/auth/session'
import { listContinueWatching, recordPosition } from '@/lib/queries/history'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  videoId: z.uuid(),
  positionSec: z.number().int().min(0).max(86_400),
  durationSec: z.number().int().min(1).max(86_400),
})

/**
 * Continue Watching. The query lives in src/lib/queries/history.ts with the
 * rest of the read layer, so it can be tested without a request context.
 */
export async function GET() {
  const user = await getSessionUser()
  if (!user) {
    return Response.json({ items: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  const items = await listContinueWatching(user.id)

  return Response.json({ items }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  const user = await getSessionUser()
  // Anonymous viewers keep their positions in localStorage instead. Not an
  // error — returning one would make the player log noise on every heartbeat.
  if (!user) return new Response(null, { status: 204 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })

  await recordPosition({
    userId: user.id,
    videoId: parsed.data.videoId,
    positionSec: parsed.data.positionSec,
    clientDurationSec: parsed.data.durationSec,
  })

  return new Response(null, { status: 204 })
}
