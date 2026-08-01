import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, episodes } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import {
  attachEpisode,
  detachEpisode,
  getAdminSeries,
  isUniqueViolation,
  listAdminEpisodes,
  recordAudit,
  updateEpisode,
} from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const attachSchema = z.object({
  action: z.literal('attach'),
  videoId: z.uuid(),
  seasonNo: z.number().int().min(1).max(99).default(1),
  episodeNo: z.number().int().min(1).max(9999),
  title: z.string().trim().max(200).optional(),
  synopsis: z.string().max(20_000).optional(),
  airedAt: z.coerce.date().nullable().optional(),
})

const patchSchema = z.object({
  action: z.literal('update'),
  episodeId: z.uuid(),
  seasonNo: z.number().int().min(1).max(99).optional(),
  episodeNo: z.number().int().min(1).max(9999).optional(),
  title: z.string().trim().max(200).nullable().optional(),
  synopsis: z.string().max(20_000).nullable().optional(),
  airedAt: z.coerce.date().nullable().optional(),
})

const detachSchema = z.object({
  action: z.literal('detach'),
  episodeId: z.uuid(),
})

const bodySchema = z.discriminatedUnion('action', [attachSchema, patchSchema, detachSchema])

async function assertSeries(seriesId: string): Promise<Response | null> {
  if (!z.uuid().safeParse(seriesId).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  const exists = await getAdminSeries(seriesId)
  if (!exists) return Response.json({ error: 'not_found' }, { status: 404 })
  return null
}

/**
 * One endpoint for the three operations on a series' episodes, so the editor
 * UI can call a single URL with a discriminated body rather than three.
 *
 * The reorder case (rewriting season/episode numbers across the whole series)
 * lives on its own route below at `/reorder` because it carries an array,
 * which does not fit a discriminated-union schema cleanly.
 */
export async function POST(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  const seriesCheck = await assertSeries(id)
  if (seriesCheck) return seriesCheck

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  if (parsed.data.action === 'attach') {
    // The episodes_video_key unique index enforces "a video belongs to at most
    // one series" — the constraint message is a 500 if it leaks through, which
    // is the wrong place to teach an operator. Catch the index violation and
    // explain it as 409 instead.
    try {
      await attachEpisode({
        seriesId: id,
        videoId: parsed.data.videoId,
        seasonNo: parsed.data.seasonNo,
        episodeNo: parsed.data.episodeNo,
        title: parsed.data.title ?? null,
        synopsis: parsed.data.synopsis ?? null,
        airedAt: parsed.data.airedAt ?? null,
      })
    } catch (error) {
      // The unique on (series_id, season_no, episode_no) — picking a slot
      // already used by another episode in the same series.
      if (isUniqueViolation(error, 'episodes_series_season_ep_key')) {
        return Response.json(
          { error: 'slot_taken', detail: 'That season/episode slot is already used in this series.' },
          { status: 409 },
        )
      }
      // The unique on (video_id) — a video can only be in one series.
      if (isUniqueViolation(error, 'episodes_video_key')) {
        return Response.json(
          { error: 'already_attached', detail: 'That video is already an episode of another series.' },
          { status: 409 },
        )
      }
      throw error
    }

    await recordAudit({
      actorId: gate.user.id,
      action: 'episode.attach',
      entityType: 'episode',
      entityId: parsed.data.videoId,
      after: { seriesId: id, seasonNo: parsed.data.seasonNo, episodeNo: parsed.data.episodeNo },
      ip: clientIp(request),
    })

    return Response.json({ ok: true })
  }

  if (parsed.data.action === 'update') {
    const [before] = await db
      .select()
      .from(episodes)
      .where(eq(episodes.id, parsed.data.episodeId))
      .limit(1)
    if (!before) return Response.json({ error: 'not_found' }, { status: 404 })

    // The series id is part of the audit trail: nothing else records which
    // series this episode row belongs to once the editor is closed.
    if (before.seriesId !== id) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }

    try {
      await updateEpisode(parsed.data.episodeId, {
        seasonNo: parsed.data.seasonNo,
        episodeNo: parsed.data.episodeNo,
        title: parsed.data.title,
        synopsis: parsed.data.synopsis,
        airedAt: parsed.data.airedAt,
      })
    } catch (error) {
      if (isUniqueViolation(error, 'episodes_series_season_ep_key')) {
        return Response.json(
          { error: 'slot_taken', detail: 'That season/episode slot is already used in this series.' },
          { status: 409 },
        )
      }
      throw error
    }

    await recordAudit({
      actorId: gate.user.id,
      action: 'episode.update',
      entityType: 'episode',
      entityId: parsed.data.episodeId,
      before: { seasonNo: before.seasonNo, episodeNo: before.episodeNo, title: before.title },
      after: {
        seasonNo: parsed.data.seasonNo ?? before.seasonNo,
        episodeNo: parsed.data.episodeNo ?? before.episodeNo,
        title: parsed.data.title !== undefined ? parsed.data.title : before.title,
      },
      ip: clientIp(request),
    })

    return Response.json({ ok: true })
  }

  // detach
  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, parsed.data.episodeId))
    .limit(1)
  if (!episode || episode.seriesId !== id) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  await detachEpisode(parsed.data.episodeId)

  await recordAudit({
    actorId: gate.user.id,
    action: 'episode.detach',
    entityType: 'episode',
    entityId: parsed.data.episodeId,
    before: { seriesId: id, videoId: episode.videoId, seasonNo: episode.seasonNo, episodeNo: episode.episodeNo },
    ip: clientIp(request),
  })

  return Response.json({ ok: true })
}

/** GET so the editor can hydrate the episode list without a re-render. */
export async function GET(_request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  const seriesCheck = await assertSeries(id)
  if (seriesCheck) return seriesCheck

  return Response.json(
    { episodes: await listAdminEpisodes(id) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
