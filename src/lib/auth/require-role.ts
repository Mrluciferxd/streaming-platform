import { notFound } from 'next/navigation'

import { getSessionUser, type SessionUser } from '@/lib/auth/session'

/**
 * Role gate for the operator surface.
 *
 * Everything under /admin and /api/admin answers **404**, never 403, to anyone
 * who is not an operator. A 403 confirms the route exists, which turns the
 * admin panel into a discoverable target: an attacker who knows
 * /admin/videos/<id> is real can go looking for a session-fixation or IDOR bug
 * on a surface they otherwise would not know to probe. Indistinguishable from
 * "no such page" costs nothing and removes the signal.
 *
 * Moderators are included because takedown is their job (IT Rules gives the
 * Grievance Officer 15 days, and that clock does not pause for an admin to be
 * available). Creators are not: they may upload, but the library, analytics and
 * audit trail are not theirs to see.
 */

export const ADMIN_ROLES = ['admin', 'moderator'] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]

export function isOperator(user: SessionUser | null): user is SessionUser & { role: AdminRole } {
  return user !== null && (ADMIN_ROLES as readonly string[]).includes(user.role)
}

/**
 * Server components. Renders the ordinary not-found page for anyone else.
 *
 * Call this in every admin page, not only the layout: Next.js reuses a layout
 * across client-side navigations within the same segment, so a gate that lives
 * only there is not re-evaluated on every request.
 */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!isOperator(user)) notFound()

  return user
}

type Gate = { user: SessionUser; denied: null } | { user: null; denied: Response }

/**
 * Route handlers.
 *
 *   const gate = await requireAdminApi()
 *   if (gate.denied) return gate.denied
 *
 * After that guard `gate.user` narrows to a real user, so no handler can forget
 * to check and still compile.
 */
export async function requireAdminApi(): Promise<Gate> {
  const user = await getSessionUser()
  if (!isOperator(user)) return { user: null, denied: notFoundJson() }

  return { user, denied: null }
}

export function notFoundJson(): Response {
  return Response.json(
    { error: 'not_found' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  )
}
