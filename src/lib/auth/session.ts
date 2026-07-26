import { createHash, randomBytes } from 'node:crypto'

import { and, eq, gt, lt } from 'drizzle-orm'
import { cookies } from 'next/headers'

import { db, sessions, users } from '@/db'
import { isProd } from '@/lib/env'

/**
 * Server-side sessions.
 *
 * The cookie carries an opaque random token; only its SHA-256 is stored. A
 * database leak therefore hands over no usable sessions, which a JWT-in-cookie
 * scheme cannot claim — and unlike a JWT, a session here can be revoked the
 * moment its row is deleted.
 *
 * SHA-256 rather than a slow KDF is correct for this specific case: the token
 * is 256 bits of CSPRNG output, so there is no low-entropy space to brute
 * force. Slow hashing is for passwords, where humans choose the input.
 */

export const SESSION_COOKIE = 'sid_auth'
const TOKEN_BYTES = 32
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type SessionUser = {
  id: string
  email: string | null
  displayName: string
  role: 'viewer' | 'creator' | 'moderator' | 'admin'
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<void> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    ip: meta.ip?.slice(0, 45) ?? null,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
  })

  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    // 'lax' rather than 'strict': 'strict' withholds the cookie on the first
    // request after following an external link, so a viewer arriving from
    // search would land logged out and log back in on the next click.
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

/** The signed-in user, or null. Safe to call from any server component. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      deletedAt: users.deletedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1)

  // A soft-deleted user keeps their rows for referential integrity but must not
  // be able to authenticate.
  if (!row || row.deletedAt) return null

  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role }
}

export async function destroySession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value

  // Delete the row, not just the cookie — otherwise a copy of the token taken
  // before logout stays valid for its full 30 days.
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))

  jar.delete(SESSION_COOKIE)
}

/** Housekeeping for the cron job. Expired rows are dead weight on the index. */
export async function purgeExpiredSessions(): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id })

  return rows.length
}

export function clientIp(request: Request): string | undefined {
  // Vercel and most proxies set x-forwarded-for; the first entry is the client.
  const forwarded = request.headers.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() || undefined
}
