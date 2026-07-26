import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db, users } from '@/db'
import { fakeVerify, verifyPassword } from '@/lib/auth/password'
import { clientIp, createSession } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
})

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'invalid_credentials' }, { status: 401 })
  }

  const { email, password } = parsed.data

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email.toLowerCase()}`, isNull(users.deletedAt)))
    .limit(1)

  /**
   * Burn equivalent work when the account does not exist.
   *
   * Without this, a missing account returns in microseconds and a real one
   * takes ~100 ms of scrypt. That difference is measurable over the network and
   * is enough to enumerate which addresses are registered — which on a service
   * holding viewing history is a privacy leak in its own right.
   */
  if (!user?.passwordHash) {
    await fakeVerify()
    return Response.json({ error: 'invalid_credentials' }, { status: 401 })
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    // Same message and same status as an unknown account. Distinguishing them
    // would undo the timing work above.
    return Response.json({ error: 'invalid_credentials' }, { status: 401 })
  }

  await createSession(user.id, {
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
  })

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE() {
  const { destroySession } = await import('@/lib/auth/session')
  await destroySession()
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
