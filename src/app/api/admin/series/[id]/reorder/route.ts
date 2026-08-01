import { z } from 'zod'

import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { getAdminSeries, recordAudit, reorderEpisodes } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const reorderSchema = z.object({
  // The full ordered list of (episodeId, seasonNo, episodeNo) for the series.
  // A whole-array rewrite, not pairwise swaps: the new order is a sequence
  // property, and swaps under concurrent edits race (same reasoning as
  // /api/admin/categories/reorder).
  order: z
    .array(
      z.object({
        episodeId: z.uuid(),
        seasonNo: z.number().int().min(1).max(99),
        episodeNo: z.number().int().min(1).max(9999),
      }),
    )
    .min(1)
    .max(2000),
})

export async function POST(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const exists = await getAdminSeries(id)
  if (!exists) return Response.json({ error: 'not_found' }, { status: 404 })

  const parsed = reorderSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  await reorderEpisodes(parsed.data.order.map((item) => ({
    episodeId: item.episodeId,
    seasonNo: item.seasonNo,
    episodeNo: item.episodeNo,
  })))

  await recordAudit({
    actorId: gate.user.id,
    action: 'episode.update',
    entityType: 'series',
    entityId: id,
    after: { reordered: parsed.data.order.length },
    ip: clientIp(request),
  })

  return Response.json({ ok: true, reordered: parsed.data.order.length })
}
