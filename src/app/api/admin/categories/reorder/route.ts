import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { categories, db } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { recordAudit } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

const schema = z.object({ ids: z.array(z.uuid()).min(1).max(200) })

/**
 * Rewrite the whole order.
 *
 * The client sends the full sequence and the server writes `sort_order = index`
 * rather than accepting "move this one up". Swapping a pair is fewer bytes but
 * races: two operators reordering at once interleave into an order neither
 * chose, and a list that started with duplicate sort_order values (the column
 * defaults to 0) never converges. Writing the whole array in one transaction is
 * last-write-wins, which is at least an order somebody picked.
 */
export async function POST(request: Request) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const { ids } = parsed.data
  if (new Set(ids).size !== ids.length) {
    return Response.json({ error: 'duplicate_ids' }, { status: 400 })
  }

  await db.transaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.update(categories).set({ sortOrder: index }).where(eq(categories.id, id))
    }

    await recordAudit(
      {
        actorId: gate.user.id,
        action: 'category.reorder',
        entityType: 'category',
        after: { order: ids },
        ip: clientIp(request),
      },
      tx,
    )
  })

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
