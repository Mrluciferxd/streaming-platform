import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, series } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import {
  deleteAdminSeries,
  getAdminSeries,
  isUniqueViolation,
  recordAudit,
  updateAdminSeries,
} from '@/lib/queries/admin'
import { slugify } from '@/lib/slug'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().min(1).max(160).optional(),
  synopsis: z.string().max(20_000).nullable().optional(),
  posterUrl: z.string().trim().max(1024).nullable().optional(),
  portraitUrl: z.string().trim().max(1024).nullable().optional(),
  bannerUrl: z.string().trim().max(1024).nullable().optional(),
  status: z.enum(['announced', 'airing', 'hiatus', 'completed', 'cancelled']).optional(),
  totalEpisodes: z.number().int().positive().max(9999).nullable().optional(),
  studio: z.string().trim().max(120).nullable().optional(),
  releaseYear: z.number().int().min(1900).max(2200).nullable().optional(),
  seasonLabel: z.string().trim().max(24).nullable().optional(),
})

export async function GET(_request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const detail = await getAdminSeries(id)
  if (!detail) return Response.json({ error: 'not_found' }, { status: 404 })

  return Response.json(
    { series: detail },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

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

  const before = await getAdminSeries(id)
  if (!before) return Response.json({ error: 'not_found' }, { status: 404 })

  // Normalise the slug here rather than in the query: the query writes whatever
  // it gets, and an un-slugified slug would break /series/<slug> the moment the
  // site tried to link to it.
  const set: Record<string, unknown> = { ...parsed.data }

  if (parsed.data.slug !== undefined) {
    const slug = slugify(parsed.data.slug)
    if (!slug) return Response.json({ error: 'slug_empty' }, { status: 400 })
    set.slug = slug
  }

  // The check constraints on series (total_episodes > 0, release_year range)
  // are in the schema; the zod schema mirrors them so a 400 reaches the
  // operator before the database has to reject the statement.

  try {
    await updateAdminSeries(id, set)
  } catch (error) {
    if (isUniqueViolation(error, 'series_slug_key')) {
      return Response.json({ error: 'slug_taken', slug: set.slug }, { status: 409 })
    }
    throw error
  }

  await recordAudit({
    actorId: gate.user.id,
    action: 'series.update',
    entityType: 'series',
    entityId: id,
    before: { slug: before.slug, title: before.title, status: before.status },
    after: {
      slug: set.slug ?? before.slug,
      title: set.title ?? before.title,
      status: set.status ?? before.status,
    },
    ip: clientIp(request),
  })

  return Response.json({
    ok: true,
    slug: set.slug ?? before.slug,
    slugChanged: set.slug !== undefined && set.slug !== before.slug,
  })
}

export async function DELETE(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  // Read the row before deleting it; the audit record needs the slug and title
  // to be meaningful once the row is gone, and the cascade that removes the
  // episodes rows also takes the only other place those references live.
  const [before] = await db.select().from(series).where(eq(series.id, id)).limit(1)
  if (!before) return Response.json({ error: 'not_found' }, { status: 404 })

  const { episodeCount } = await deleteAdminSeries(id)

  await recordAudit({
    actorId: gate.user.id,
    action: 'series.delete',
    entityType: 'series',
    entityId: id,
    before: { slug: before.slug, title: before.title, episodeCount },
    ip: clientIp(request),
  })

  return Response.json({ ok: true, detachedEpisodes: episodeCount })
}
