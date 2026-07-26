import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, videoCategories, videos } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { AGE_RATINGS, recordAudit } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * A stored media path, not a URL.
 *
 * The database holds bucket-relative paths so that swapping providers is a
 * config change (README, "Provider swap rule"). An operator pasting the CDN URL
 * they see in the preview would bake the current provider's hostname into the
 * row and break silently on migration — and it is exactly what a text field
 * invites, so it is rejected here rather than documented.
 */
const bucketPath = z
  .string()
  .max(500)
  .refine((v) => v === '' || !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(v.trim()), {
    message: 'Use a bucket path like v/<id>/portrait.jpg, not a full URL.',
  })
  .refine((v) => !v.includes('..'), { message: 'Path may not contain "..".' })

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => (v && v.trim() ? v.trim() : null))

const patchSchema = z.object({
  title: z.string().min(1).max(200),
  description: optionalText(20_000),
  language: z.string().min(2).max(10),
  ageRating: z.enum(AGE_RATINGS),
  contentDescriptor: optionalText(500),
  categoryIds: z.array(z.uuid()).max(30),
  hasSub: z.boolean(),
  hasDub: z.boolean(),
  seasonLabel: optionalText(24),
  score: z.number().int().min(0).max(100).nullable(),
  portraitUrl: bucketPath.nullable().transform((v) => (v && v.trim() ? v.trim() : null)),
})

/** Update metadata and category assignments. */
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

  const [before] = await db.select().from(videos).where(eq(videos.id, id)).limit(1)
  if (!before) return Response.json({ error: 'not_found' }, { status: 404 })

  const { categoryIds, ...fields } = parsed.data

  await db.transaction(async (tx) => {
    await tx
      .update(videos)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(videos.id, id))

    // Replace rather than diff: the set is at most a few dozen rows and a
    // delete-then-insert inside the transaction cannot leave a half-applied
    // taxonomy the way a sequence of adds and removes can.
    await tx.delete(videoCategories).where(eq(videoCategories.videoId, id))
    if (categoryIds.length > 0) {
      await tx
        .insert(videoCategories)
        .values(categoryIds.map((categoryId) => ({ videoId: id, categoryId })))
        .onConflictDoNothing()
    }

    // Age rating and content descriptor are IT Rules self-classification, so a
    // quiet edit of them is a compliance event, not a typo fix.
    await recordAudit(
      {
        actorId: gate.user.id,
        action: 'video.update',
        entityType: 'video',
        entityId: id,
        before: {
          title: before.title,
          ageRating: before.ageRating,
          contentDescriptor: before.contentDescriptor,
          language: before.language,
        },
        after: {
          title: fields.title,
          ageRating: fields.ageRating,
          contentDescriptor: fields.contentDescriptor,
          language: fields.language,
        },
        ip: clientIp(request),
      },
      tx,
    )
  })

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Soft delete.
 *
 * `deleted_at`, never a real DELETE: the row is referenced by watch history,
 * revenue attribution and the audit trail, and a DPDP erasure request has to be
 * satisfiable without destroying the record that the erasure happened.
 */
export async function DELETE(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const [before] = await db.select().from(videos).where(eq(videos.id, id)).limit(1)
  if (!before) return Response.json({ error: 'not_found' }, { status: 404 })

  await db.transaction(async (tx) => {
    await tx
      .update(videos)
      .set({ deletedAt: new Date(), status: 'removed', updatedAt: new Date() })
      .where(eq(videos.id, id))

    await recordAudit(
      {
        actorId: gate.user.id,
        action: 'video.delete',
        entityType: 'video',
        entityId: id,
        before: { status: before.status, deletedAt: before.deletedAt, title: before.title },
        after: { status: 'removed', deletedAt: new Date().toISOString() },
        ip: clientIp(request),
      },
      tx,
    )
  })

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
