import { index, integer, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core'

/**
 * Operational tables — things the platform needs to defend itself, not things
 * the product reads.
 *
 * NOT included in drizzle.config.ts, for the same reason as
 * schema-analytics.ts: the real DDL is hand-written (drizzle/0005_rate_limit.sql)
 * and this definition exists to give queries type safety. Keeping it out of the
 * generated schema also keeps this file clear of whatever drizzle-kit is doing
 * to schema.ts.
 */

/**
 * Fixed-window request counters. One row per (bucket, identity) — the window
 * rolls in place rather than accumulating a row per window, so the table stays
 * proportional to the number of active callers instead of to traffic.
 *
 * Postgres rather than Redis because Redis is not provisioned, and the property
 * that actually matters is that the counter is shared: a per-instance limiter
 * on serverless multiplies the real limit by however many instances happen to
 * be warm, which is a limit in name only.
 *
 * `identity` is a client IP, which is personal data under the DPDP Act. Rows
 * live one window and are deleted by the sweeper cron shortly after, so the
 * retention here is minutes — deliberately, not incidentally.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    /** Which limiter: 'events', 'auth:login', 'auth:register'. */
    bucket: varchar('bucket', { length: 40 }).notNull(),
    /** Who is being counted. An IPv6 address is at most 45 characters. */
    identity: varchar('identity', { length: 64 }).notNull(),
    /**
     * Start of the current window, floored to a multiple of the window length
     * against the *database* clock. Every serverless instance therefore agrees
     * on where the window boundary is without any of them agreeing on the time.
     */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.identity] }),
    // The sweeper's index. Without it the cleanup pass seq-scans a table whose
    // whole point is to be written to on every request.
    index('rate_limits_expiry_idx').on(t.expiresAt),
  ],
)
