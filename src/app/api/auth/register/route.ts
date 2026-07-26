import { z } from 'zod'

import { db, users } from '@/db'
import { hashPassword } from '@/lib/auth/password'
import { clientIp, createSession } from '@/lib/auth/session'
import { clientIdentity, rateLimit, RULES, tooManyRequests } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  email: z.email().max(320),
  // Length over composition rules. NIST dropped the character-class
  // requirements years ago: they push people toward "Password1!" and add
  // almost nothing against an offline attack.
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(80),
  /**
   * DPDP Act 2023 requires consent to be explicit and demonstrable, so it is
   * recorded rather than assumed from the act of signing up.
   */
  consent: z.literal(true),
})

const CONSENT_VERSION = '2026-07'

export async function POST(request: Request) {
  // First, so that a signup flood is stopped before it buys ~100ms of scrypt on
  // a serverless instance and a permanent row.
  const limit = await rateLimit(RULES.register, clientIdentity(request))
  if (!limit.ok) return tooManyRequests(limit)

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { email, password, displayName } = parsed.data
  const passwordHash = await hashPassword(password)

  /**
   * Insert first and let the unique index decide, rather than checking for an
   * existing address and then inserting. The check-then-insert version has a
   * race between the two statements, and the index is the only thing that can
   * actually guarantee uniqueness.
   */
  const [created] = await db
    .insert(users)
    .values({
      email: email.toLowerCase(),
      displayName,
      passwordHash,
      consentedAt: new Date(),
      consentVersion: CONSENT_VERSION,
    })
    .onConflictDoNothing()
    .returning({ id: users.id })

  if (!created) {
    /**
     * Deliberately not "that email is already registered". Saying so turns this
     * endpoint into an account-enumeration oracle: anyone could test a list of
     * addresses to learn who has an account here — which, on a service where
     * viewing history is sensitive, is itself a privacy leak.
     */
    return Response.json(
      { error: 'registration_failed', message: 'Could not create that account.' },
      { status: 409 },
    )
  }

  await createSession(created.id, {
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent') ?? undefined,
  })

  // Email verification is not wired up yet — it needs a transactional mail
  // provider. `users.email_verified` stays false until it is.
  return Response.json({ ok: true, userId: created.id }, { headers: { 'Cache-Control': 'no-store' } })
}
