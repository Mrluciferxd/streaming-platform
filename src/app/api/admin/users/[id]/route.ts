import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, users } from '@/db'
import { requireAdminApi } from '@/lib/auth/require-role'
import { clientIp } from '@/lib/auth/session'
import { recordAudit } from '@/lib/queries/admin'
import { countAdmins, getUser, type UserRole } from '@/lib/queries/users'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const roleSchema = z.enum(['viewer', 'creator', 'moderator', 'admin'])

/**
 * Change a user's role. Records the change in `audit_log`.
 *
 * Refuses to demote the last admin: a deployment with zero admins cannot be
 * re-adminned from the UI, and the lockout recovery is raw SQL — which is the
 * right call for a lockout (it should not be one stray click away), but the
 * operator must be told they are about to lock themselves out beforehand.
 */
export async function PATCH(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const parsed = z.object({ role: roleSchema }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const before = await getUser(id)
  if (!before || before.deletedAt) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  // Last-admin guard. Only applies when demoting an admin (downgrade), not
  // when the row is already a non-admin target.
  if (before.role === 'admin' && parsed.data.role !== 'admin') {
    const adminCount = await countAdmins()
    if (adminCount <= 1) {
      return conflict('last_admin')
    }
  }

  const now = new Date()
  await db.transaction(async (tx) => {
    await tx.update(users).set({ role: parsed.data.role as UserRole, updatedAt: now }).where(eq(users.id, id))
    await recordAudit(
      {
        actorId: gate.user.id,
        action: 'user.role',
        entityType: 'user',
        entityId: id,
        before: { role: before.role },
        after: { role: parsed.data.role, displayName: before.displayName },
        ip: clientIp(request),
      },
      tx,
    )
  })

  const updated = await getUser(id)

  return Response.json(
    { ok: true, role: updated?.role ?? parsed.data.role },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * Soft delete a user. Stamps `deleted_at` and nulls the PII columns (email,
 * phone, passwordHash, avatarUrl) to honour a DPDP Act 2023 erasure request
 * while keeping referential integrity — watch history and audit actor rows
 * survive; displayName is kept so an audit row reads a name, not "Deleted
 * account".
 *
 * Refuses on the last admin for the same reason as PATCH.
 */
export async function DELETE(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const before = await getUser(id)
  if (!before) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  if (before.deletedAt) {
    return conflict('already_deleted')
  }
  if (before.role === 'admin') {
    const adminCount = await countAdmins()
    if (adminCount <= 1) {
      return conflict('last_admin')
    }
  }

  await db.transaction(async (tx) => {
    const now = new Date()
    await tx
      .update(users)
      .set({ email: null, phone: null, passwordHash: null, avatarUrl: null, deletedAt: now, updatedAt: now })
      .where(eq(users.id, id))
    await recordAudit(
      {
        actorId: gate.user.id,
        action: 'user.delete',
        entityType: 'user',
        entityId: id,
        before: { role: before.role, displayName: before.displayName },
        after: { deletedAt: now.toISOString() },
        ip: clientIp(request),
      },
      tx,
    )
  })

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Restore a soft-deleted user. The PII that was nulled on delete is gone, and
 * the schema's `users_identifier_present` check (a live user must have email or
 * phone) would refuse to unhole a row that has neither. So a restore is a
 * two-field operation: clear `deleted_at` AND re-set an `email` the operator
 * supplies from out-of-band. The email must not collide with another live row.
 *
 * A restore without an email (`{}` body) returns `email_required`: the caller
 * must decide what address the restored account will carry.
 */
export async function POST(request: Request, { params }: Params) {
  const gate = await requireAdminApi()
  if (gate.denied) return gate.denied

  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const parsed = z.object({ email: z.string().email().max(320).optional() }).safeParse(
    await request.json().catch(() => ({})),
  )
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }

  const before = await getUser(id)
  if (!before) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  if (!before.deletedAt) {
    return conflict('not_deleted')
  }

  // The row may already have a retained email (delete kept it for some reason
  // — e.g. a future "hard delete" flag). If the caller omits one and the row
  // has email or phone, the restore is clean. If both are null AND no email
  // was supplied, refuse — a live user cannot have no identifier.
  const hasIdentifier = before.email !== null || before.phone !== null
  const email = parsed.data.email
  if (!hasIdentifier && !email) {
    return conflict('email_required')
  }

  const deletedAtIso = before.deletedAt.toISOString()

  await db.transaction(async (tx) => {
    const now = new Date()
    const set: Record<string, unknown> = { deletedAt: null, updatedAt: now }
    if (email) set.email = email
    await tx
      .update(users)
      .set(set)
      .where(eq(users.id, id))
    await recordAudit(
      {
        actorId: gate.user.id,
        action: 'user.restore',
        entityType: 'user',
        entityId: id,
        before: { deletedAt: deletedAtIso },
        after: { displayName: before.displayName, ...(email ? { email } : {}) },
        ip: clientIp(request),
      },
      tx,
    )
  })

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}

function conflict(reason: string): Response {
  return Response.json({ error: reason }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
}
