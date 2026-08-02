import { z } from 'zod'

import { db } from '@/db'
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

  // The zod schema validates the shape but not that the (season, episode)
  // pairs in the new order are distinct. Two rows assigned the same slot
  // would violate episodes_series_season_ep_key no matter how the writes are
  // sequenced, so reject that up front with the same 409 the single-update
  // attach path returns, rather than letting it surface as a 500.
  const keys = new Set(
    parsed.data.order.map((item) => `${item.seasonNo}:${item.episodeNo}`),
  )
  if (keys.size !== parsed.data.order.length) {
    return Response.json(
      { error: 'slot_taken', detail: 'Two episodes are assigned the same season/episode slot.' },
      { status: 409 },
    )
  }

  const ordered = parsed.data.order.map((item) => ({
    episodeId: item.episodeId,
    seasonNo: item.seasonNo,
    episodeNo: item.episodeNo,
  }))

  await db.transaction(async (tx) => {
    await reorderEpisodes(ordered, tx)

    await recordAudit(
      {
        actorId: gate.user.id,
        action: 'episode.update',
        entityType: 'series',
        entityId: id,
        after: { reordered: parsed.data.order.length },
        ip: clientIp(request),
      },
      tx,
    )
  })

  return Response.json({ ok: true, reordered: parsed.data.order.length })
}
