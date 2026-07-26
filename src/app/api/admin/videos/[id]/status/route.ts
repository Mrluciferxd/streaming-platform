import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, videos } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { recordAudit, type AuditAction } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('publish') }),
  z.object({ action: z.literal('unpublish') }),
  z.object({ action: z.literal('schedule'), at: z.coerce.date() }),
  // A takedown without a stated reason is not a compliance record, so the
  // reason is required rather than optional.
  z.object({ action: z.literal('takedown'), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal('restore') }),
])

/**
 * Publish, unpublish, schedule, take down, restore.
 *
 * Separate from PATCH because these are the decisions, not the data: they are
 * the actions the audit trail exists for, they have their own preconditions,
 * and mixing them into the metadata form would make an accidental publish one
 * stray keystroke away.
 */
export async function POST(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const [video] = await db.select().from(videos).where(eq(videos.id, id)).limit(1)
  if (!video) return Response.json({ error: 'not_found' }, { status: 404 })

  const now = new Date()
  const before = { status: video.status, publishedAt: video.publishedAt, deletedAt: video.deletedAt }

  let update: Partial<typeof videos.$inferInsert>
  let action: AuditAction
  let extra: Record<string, unknown> = {}

  switch (parsed.data.action) {
    case 'publish': {
      if (video.deletedAt) return conflict('video_deleted')
      // Publishing a row with no master playlist puts a title on the homepage
      // that 404s the moment anyone clicks it.
      if (!video.hlsMasterPath) return conflict('no_playable_media')
      if (video.status === 'removed') return conflict('restore_before_publishing')

      update = { status: 'published', publishedAt: video.publishedAt ?? now }
      action = 'video.publish'
      break
    }

    case 'schedule': {
      if (video.deletedAt) return conflict('video_deleted')
      if (!video.hlsMasterPath) return conflict('no_playable_media')
      if (parsed.data.at.getTime() <= now.getTime()) return conflict('scheduled_time_in_past')

      /**
       * Scheduling leaves the row at `ready` and parks the go-live time in
       * `published_at`. It cannot set `published` early: the public queries
       * filter on status alone, so a future-dated published row would appear on
       * the homepage immediately and simply sort to the top.
       *
       * The sweep in /api/admin/publish-due flips these when they come due.
       */
      update = { status: 'ready', publishedAt: parsed.data.at }
      action = 'video.schedule'
      extra = { scheduledFor: parsed.data.at.toISOString() }
      break
    }

    case 'unpublish': {
      // publishedAt survives, so re-publishing restores the original ordering
      // instead of jumping the title back to the top of "Latest".
      update = { status: 'unpublished' }
      action = 'video.unpublish'
      break
    }

    case 'takedown': {
      update = { status: 'removed' }
      action = 'video.takedown'
      extra = { reason: parsed.data.reason }
      break
    }

    case 'restore': {
      update = { status: 'ready', deletedAt: null }
      action = 'video.restore'
      break
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(videos)
      .set({ ...update, updatedAt: now })
      .where(eq(videos.id, id))

    await recordAudit(
      {
        actorId: gate.user.id,
        action,
        entityType: 'video',
        entityId: id,
        before,
        after: { ...before, ...update, ...extra, title: video.title },
        ip: clientIp(request),
      },
      tx,
    )
  })

  return Response.json(
    { ok: true, status: update.status },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

function conflict(reason: string): Response {
  return Response.json({ error: reason }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
}
