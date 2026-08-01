import { z } from 'zod'

import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { isUniqueViolation, listAdminSeries, recordAudit, createAdminSeries } from '@/lib/queries/admin'
import { slugify } from '@/lib/slug'

export const dynamic = 'force-dynamic'

// The status enum is short and stable enough that a literal union beats
// importing `SERIES_STATUSES` into the validation layer too — and a literal
// makes the body schema readable without jumping to the source.
const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(160).optional(),
  synopsis: z.string().max(20_000).optional(),
  status: z.enum(['announced', 'airing', 'hiatus', 'completed', 'cancelled']).optional(),
  totalEpisodes: z.number().int().positive().max(9999).nullable().optional(),
  studio: z.string().trim().max(120).optional(),
  releaseYear: z.number().int().min(1900).max(2200).nullable().optional(),
  seasonLabel: z.string().trim().max(24).optional(),
})

export async function GET() {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  return Response.json(
    { series: await listAdminSeries() },
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

  const slug = slugify(parsed.data.slug || parsed.data.title)
  if (!slug) return Response.json({ error: 'slug_empty' }, { status: 400 })

  try {
    const row = await createAdminSeries({
      slug,
      title: parsed.data.title,
      synopsis: parsed.data.synopsis ?? null,
      status: parsed.data.status,
      totalEpisodes: parsed.data.totalEpisodes ?? null,
      studio: parsed.data.studio ?? null,
      releaseYear: parsed.data.releaseYear ?? null,
      seasonLabel: parsed.data.seasonLabel ?? null,
    })

    await recordAudit({
      actorId: gate.user.id,
      action: 'series.create',
      entityType: 'series',
      entityId: row.id,
      after: { slug: row.slug, title: parsed.data.title, status: parsed.data.status ?? 'airing' },
      ip: clientIp(request),
    })

    return Response.json({ ok: true, id: row.id, slug: row.slug })
  } catch (error) {
    // episodes cascade on delete, but a re-insert with an existing slug still
    // trips the series_slug_key unique index — exactly the case a taken slug
    // should explain itself rather than look like an internal crash.
    if (isUniqueViolation(error, 'series_slug_key')) {
      return Response.json({ error: 'slug_taken', slug }, { status: 409 })
    }
    throw error
  }
}
