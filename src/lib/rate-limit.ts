import { lt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { rateLimits } from '@/db/schema-ops'

/**
 * Fixed-window rate limiting, counted in Postgres.
 *
 * Plan §8 pairs this with Redis, and Redis is the right answer eventually. It
 * is not provisioned, and the alternative usually reached for — a Map in module
 * scope — is worse than nothing on Vercel: every warm instance keeps its own
 * counter, so the effective limit is the configured one multiplied by however
 * many instances are alive, and it resets on every cold start. A limiter that
 * cannot say what it is limiting to is decorative.
 *
 * The cost is one upsert per request. That is affordable here because the
 * endpoints being protected already write to Postgres on the same request; it
 * would not be affordable on a read path served from cache.
 *
 * Fixed window, not sliding: a caller who lands at the very end of one window
 * and the start of the next can send 2x `limit` briefly. That is the known
 * trade-off, and it is accepted deliberately — a sliding window needs either a
 * second row per caller or a sorted set, and neither is worth it to tighten a
 * bound that exists to stop floods, not to meter fairly.
 */

export type RateLimitRule = {
  /** Names the counter. Distinct buckets never share a budget. */
  bucket: string
  /** Requests allowed per window. */
  limit: number
  windowSec: number
}

export type RateLimitResult = {
  ok: boolean
  limit: number
  remaining: number
  /** Seconds until the window rolls. Goes straight into `Retry-After`. */
  retryAfterSec: number
}

/**
 * The budgets.
 *
 * All of these are per-IP, and Indian mobile carriers put very large numbers of
 * subscribers behind one CGNAT address — so an IP here is closer to "a
 * neighbourhood" than "a person". Every limit below is therefore sized to stop
 * a single abusive client without locking out a shared address, which means
 * they are deliberately loose. They bound the damage; they do not meter usage.
 */
export const RULES = {
  /**
   * Telemetry ingest. A player sends one batch every ~15s, so a real viewer is
   * ~4/min and this leaves room for a large NAT. What it removes is the trivial
   * case: a script looping on the endpoint to inflate watch time or fill the
   * partition. The 50-event batch cap in the route bounds the rest.
   */
  events: { bucket: 'events', limit: 300, windowSec: 60 },

  /**
   * Login. Credential stuffing is the threat, and it is usually distributed —
   * this raises the cost of the single-source case rather than solving the
   * general one. 20 per 5 minutes is far below any attack rate and recovers
   * quickly enough that a viewer who mistypes their password four times is not
   * locked out for the evening.
   */
  login: { bucket: 'auth:login', limit: 20, windowSec: 300 },

  /**
   * Registration. The tightest budget of the three: each attempt costs a scrypt
   * hash of CPU on a serverless instance and, if it succeeds, a permanent row.
   * Signing up is a once-per-person act, so 10 an hour per address is generous
   * even behind a shared connection.
   */
  register: { bucket: 'auth:register', limit: 10, windowSec: 3600 },
} as const satisfies Record<string, RateLimitRule>

/**
 * Count one request against `rule` and say whether it is allowed.
 *
 * Window boundaries are floored against `now()` inside Postgres, so every
 * serverless instance agrees on where the window starts without any of them
 * agreeing on the wall clock.
 */
export async function rateLimit(
  rule: RateLimitRule,
  identity: string,
): Promise<RateLimitResult> {
  const { bucket, limit, windowSec } = rule

  try {
    const rows = await db.execute<{ count: number; retry_after: number }>(sql`
      INSERT INTO rate_limits (bucket, identity, window_start, count, expires_at)
      VALUES (
        ${bucket},
        ${identity.slice(0, 64)},
        to_timestamp(floor(extract(epoch FROM now()) / ${windowSec}) * ${windowSec}),
        1,
        to_timestamp((floor(extract(epoch FROM now()) / ${windowSec}) + 1) * ${windowSec})
      )
      ON CONFLICT (bucket, identity) DO UPDATE
         SET "count"    = CASE WHEN rate_limits.window_start = excluded.window_start
                               THEN rate_limits."count" + 1
                               ELSE 1 END,
             window_start = excluded.window_start,
             expires_at   = excluded.expires_at
      RETURNING "count"::int AS count,
                greatest(ceil(extract(epoch FROM expires_at - now()))::int, 1) AS retry_after
    `)

    const count = rows[0]?.count ?? 1
    const retryAfterSec = rows[0]?.retry_after ?? windowSec

    return { ok: count <= limit, limit, remaining: Math.max(0, limit - count), retryAfterSec }
  } catch (error) {
    /**
     * Fail open.
     *
     * If the counter is unavailable the database is unavailable, and every
     * endpoint this protects is about to fail on its own next query anyway.
     * Failing closed would convert a database blip into a total outage of
     * login and telemetry — the limiter becoming the incident is a worse
     * outcome than the limiter being briefly absent.
     */
    console.error('rate limiter unavailable; allowing request', error)
    return { ok: true, limit, remaining: limit, retryAfterSec: 0 }
  }
}

/**
 * Who to count against.
 *
 * Vercel and every sane proxy put the client first in `x-forwarded-for`. The
 * header is trivially forgeable in general, but not here: the platform rewrites
 * it at the edge, so what the route sees is the connecting address. Direct
 * origin access would bypass that, which is a deployment concern rather than
 * something this function can fix.
 */
export function clientIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return (forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown').slice(0, 64)
}

/**
 * The 429 every limited route returns. `Retry-After` is not decoration: it is
 * the only thing that tells a well-behaved client to back off rather than spin,
 * and a spinning client is indistinguishable from the attack being limited.
 */
export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: 'rate_limited', retryAfterSec: result.retryAfterSec },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSec),
        'Cache-Control': 'no-store',
      },
    },
  )
}

/**
 * Cleanup path, for the sweeper cron.
 *
 * Rows are rewritten in place while a caller is active, so this only ever
 * removes callers that have gone quiet. The grace period keeps a row through
 * one extra window rather than deleting it the instant it expires, so a caller
 * hovering at the limit cannot reset their count by pausing for a second.
 */
export async function purgeExpiredRateLimits(graceSec = 3600): Promise<number> {
  const rows = await db
    .delete(rateLimits)
    .where(lt(rateLimits.expiresAt, new Date(Date.now() - graceSec * 1000)))
    .returning({ bucket: rateLimits.bucket })

  return rows.length
}
