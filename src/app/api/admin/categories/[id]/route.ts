import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { categories, db, videoCategories } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { isUniqueViolation, recordAudit } from '@/lib/queries/admin'
import { slugify } from '@/lib/slug'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable(),
  icon: z.string().trim().max(60).nullable(),
})

export async function PATCH(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const [before] = await db.select().from(categories).where(eq(categories.id, id)).limit(1)
  if (!before) return Response.json({ error: 'not_found' }, { status: 404 })

  const slug = slugify(parsed.data.slug)
  if (!slug) return Response.json({ error: 'slug_empty' }, { status: 400 })

  try {
    await db
      .update(categories)
      .set({
        name: parsed.data.name,
        slug,
        description: parsed.data.description?.trim() || null,
        icon: parsed.data.icon || null,
      })
      .where(eq(categories.id, id))
  } catch (error) {
    if (isUniqueViolation(error, 'categories_slug_key')) {
      return Response.json({ error: 'slug_taken', slug }, { status: 409 })
    }
    throw error
  }

  await recordAudit({
    actorId: gate.user.id,
    action: 'category.update',
    entityType: 'category',
    entityId: id,
    before: { slug: before.slug, name: before.name },
    after: { slug, name: parsed.data.name },
    ip: clientIp(request),
  })

  // A slug change re-points /c/<slug>; the old URL is now a 404 and anything
  // linking to it needs updating. Say so rather than letting it be discovered.
  return Response.json({ ok: true, slug, slugChanged: slug !== before.slug })
}

export async function DELETE(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const [before] = await db.select().from(categories).where(eq(categories.id, id)).limit(1)
  if (!before) return Response.json({ error: 'not_found' }, { status: 404 })

  const [assigned] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(videoCategories)
    .where(eq(videoCategories.categoryId, id))

  await db.transaction(async (tx) => {
    // video_categories cascades, so this silently un-files every video in the
    // category. The count goes in the audit row because it is the only place
    // that number survives the delete.
    await tx.delete(categories).where(eq(categories.id, id))

    await recordAudit(
      {
        actorId: gate.user.id,
        action: 'category.delete',
        entityType: 'category',
        entityId: id,
        before: { slug: before.slug, name: before.name, videoCount: assigned?.count ?? 0 },
        ip: clientIp(request),
      },
      tx,
    )
  })

  return Response.json({ ok: true, unfiled: assigned?.count ?? 0 })
}
