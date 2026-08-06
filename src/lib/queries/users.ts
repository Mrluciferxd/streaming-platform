import { and, asc, count, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm'

import { db, users } from '@/db'
import { userRole } from '@/db/schema'

export type UserRole = (typeof userRole.enumValues)[number]

export type UserRow = {
  id: string
  email: string | null
  phone: string | null
  displayName: string
  avatarUrl: string | null
  role: UserRole
  emailVerified: boolean
  consentedAt: Date | null
  createdAt: Date
  deletedAt: Date | null
}

export type UserListFilter = {
  query?: string
  role?: UserRole | 'deleted'
  page?: number
  perPage?: number
}

export type UserListPage = {
  items: UserRow[]
  total: number
  page: number
  perPage: number
}

/**
 * User management surface.
 *
 * Soft delete (`deletedAt`, with the PII columns nulled) keeps referential
 * integrity — a deleted user's watch history stays so aggregate stats don't
 * shift, audit rows keep their actor — while honouring a DPDP Act 2023
 * erasure request. The unique indexes on email/phone are partial on
 * `deletedAt IS NULL`, so a nulled email cannot collide with a fresh signup.
 *
 * Role changes and soft delete are the operator's actions; the only role a
 * viewer can never grant themselves is `admin`, and the API enforces that an
 * operator cannot demote the last admin (a shed with no admin cannot be
 * re-adminned except by raw SQL, which is the right call for a lockout).
 */

const PII_COLUMNS = {
  email: null,
  phone: null,
  passwordHash: null,
  avatarUrl: null,
  // displayName is kept: a deleted actor's audit rows would read "Deleted
  // account" otherwise, which loses the trail. displayName is not PII under
  // the DPDP Act's sensitive-data definition; email and phone are.
} as const

export async function listUsers(filter: UserListFilter = {}): Promise<UserListPage> {
  const page = Math.max(1, filter.page ?? 1)
  const perPage = Math.min(Math.max(1, filter.perPage ?? 25), 100)

  const where = filter.role === 'deleted'
    ? isNotNull(users.deletedAt)
    : and(
        isNull(users.deletedAt),
        filter.role ? eq(users.role, filter.role) : undefined,
        filter.query?.trim() ? or(ilike(users.email, `%${filter.query.trim()}%`), ilike(users.displayName, `%${filter.query.trim()}%`)) : undefined,
      )

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        phone: users.phone,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        role: users.role,
        emailVerified: users.emailVerified,
        consentedAt: users.consentedAt,
        createdAt: users.createdAt,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(where as never)
      .orderBy(asc(users.displayName), desc(users.createdAt))
      .offset((page - 1) * perPage)
      .limit(perPage),
    db
      .select({ value: count() })
      .from(users)
      .where(where as never),
  ])

  return {
    items: rows as UserRow[],
    total: Number(totalRows[0]?.value ?? 0),
    page,
    perPage,
  }
}

export async function getUser(id: string): Promise<UserRow | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      phone: users.phone,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: users.role,
      emailVerified: users.emailVerified,
      consentedAt: users.consentedAt,
      createdAt: users.createdAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)

  return (row as UserRow | undefined) ?? null
}

/**
 * Count admins. Used by the API to refuse demoting the last one.
 */
export async function countAdmins(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.deletedAt)))
  return Number(row?.value ?? 0)
}

/**
 * Change a user's role. Callers must check `countAdmins` before demoting an
 * admin to refuse the "last admin" lockout. The middleware that should mark
 * a `creator` role change as requiring a `creators` row is NOT here — role
 * change is the operator's decision and the creators surface is separate.
 */
export async function updateUserRole(id: string, role: UserRole): Promise<UserRow | null> {
  const now = new Date()
  await db
    .update(users)
    .set({ role, updatedAt: now })
    .where(eq(users.id, id))

  return getUser(id)
}

/**
 * Soft delete: stamp `deletedAt` and null the PII columns. The row stays for
 * referential integrity; the email/phone uniques are partial on `deletedAt IS
 * NULL` so a nulled email cannot block a future signup of the same address.
 */
export async function softDeleteUser(id: string): Promise<UserRow | null> {
  const now = new Date()
  await db
    .update(users)
    .set({ ...PII_COLUMNS, deletedAt: now, updatedAt: now })
    .where(eq(users.id, id))

  return getUser(id)
}

/**
 * Undo a soft delete. The PII that was nulled is gone, so this restores the
 * row to a "deleted and undeleted with no email" state — the operator must
 * re-set the email from out-of-band. Reject if any required field would be
 * missing; here that is just displayName, which was kept, so it always
 * succeeds.
 */
export async function restoreUser(id: string): Promise<UserRow | null> {
  const now = new Date()
  await db
    .update(users)
    .set({ deletedAt: null, updatedAt: now })
    .where(eq(users.id, id))

  return getUser(id)
}
