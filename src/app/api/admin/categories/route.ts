import { sql } from 'drizzle-orm'
import { z } from 'zod'

import { categories, db } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { isUniqueViolation, listAdminCategories, recordAudit } from '@/lib/queries/admin'
import { slugify } from '@/lib/slug'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Optional: derived from the name when blank, because a slug is a URL and
  // most operators should not have to think about one.
  slug: z.string().trim().max(120).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().trim().max(60).optional(),
})

export async function GET() {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  return Response.json(
    { categories: await listAdminCategories() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(request: Request) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const slug = slugify(parsed.data.slug || parsed.data.name)
  if (!slug) return Response.json({ error: 'slug_empty' }, { status: 400 })

  // New categories land at the end. Reordering is a separate, explicit action —
  // creating one should never shuffle the navigation.
  const [maxOrder] = await db
    .select({ next: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
    .from(categories)

  try {
    const [row] = await db
      .insert(categories)
      .values({
        slug,
        name: parsed.data.name,
        description: parsed.data.description?.trim() || null,
        icon: parsed.data.icon || null,
        sortOrder: Number(maxOrder?.next ?? 0),
      })
      .returning({ id: categories.id, slug: categories.slug })

    if (!row) return Response.json({ error: 'insert_failed' }, { status: 500 })

    await recordAudit({
      actorId: gate.user.id,
      action: 'category.create',
      entityType: 'category',
      entityId: row.id,
      after: { slug: row.slug, name: parsed.data.name },
      ip: clientIp(request),
    })

    return Response.json({ ok: true, id: row.id, slug: row.slug })
  } catch (error) {
    // A duplicate slug is an operator mistake, not a 500.
    if (isUniqueViolation(error, 'categories_slug_key')) {
      return Response.json({ error: 'slug_taken', slug }, { status: 409 })
    }
    throw error
  }
}
