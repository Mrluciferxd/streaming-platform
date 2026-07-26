/**
 * The rate limiter, against a real Postgres.
 *
 *   npm run check:rate-limit
 *
 * A limiter that quietly stops limiting looks exactly like a limiter that is
 * working: no errors, no logs, every request served. The failure modes are all
 * silent — an upsert that inserts a second row per window instead of counting,
 * a window that never rolls so a caller is blocked forever, a window that rolls
 * on every request so nobody is ever blocked. Each one is one character of SQL
 * away, so each one is asserted here.
 *
 * Writes and deletes rows in `rate_limits`, under identities no real caller
 * can have.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import type * as DbModule from '../src/db/index.ts'
import type * as RateLimitModule from '../src/lib/rate-limit.ts'
import { unmet } from './support.ts'

const skip = unmet(process.env.DATABASE_URL ? null : 'DATABASE_URL is not set')

const { db, sqlClient } = skip ? ({} as typeof DbModule) : await import('../src/db/index.ts')
const { purgeExpiredRateLimits, rateLimit, RULES, clientIdentity, tooManyRequests } = skip
  ? ({} as typeof RateLimitModule)
  : await import('../src/lib/rate-limit.ts')

const bucket = `check:${randomUUID().slice(0, 8)}`
const identity = () => `10.0.0.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 8)}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Time to the next window boundary on the database clock, plus a little. */
async function msUntilNextWindow(windowSec: number): Promise<number> {
  const [row] = await db.execute<{ ms: number }>(sql`
    SELECT ((${windowSec} - (extract(epoch FROM now()) % ${windowSec})) * 1000)::int AS ms
  `)
  return Number(row?.ms ?? windowSec * 1000) + 150
}

describe('rate limiter', { skip }, () => {
  after(async () => {
    await db.execute(sql`DELETE FROM rate_limits WHERE bucket LIKE 'check:%'`)
    await sqlClient.end()
  })

  it('counts up to the limit and then refuses', async () => {
    const rule = { bucket, limit: 3, windowSec: 60 }
    const who = identity()

    const results = []
    for (let i = 0; i < 5; i++) results.push(await rateLimit(rule, who))

    assert.deepEqual(
      results.map((r) => r.ok),
      [true, true, true, false, false],
    )
    assert.deepEqual(
      results.map((r) => r.remaining),
      [2, 1, 0, 0, 0],
      'remaining never goes negative',
    )
  })

  it('keeps one row per identity rather than one per request', async () => {
    const rule = { bucket, limit: 10, windowSec: 60 }
    const who = identity()

    for (let i = 0; i < 4; i++) await rateLimit(rule, who)

    const [row] = await db.execute<{ n: number; count: number }>(sql`
      SELECT count(*)::int AS n, max("count")::int AS count
        FROM rate_limits WHERE bucket = ${bucket} AND identity = ${who}
    `)

    assert.equal(row?.n, 1, 'the upsert inserted instead of counting')
    assert.equal(row?.count, 4)
  })

  it('counts each identity separately', async () => {
    const rule = { bucket, limit: 1, windowSec: 60 }
    const [a, b] = [identity(), identity()]

    assert.equal((await rateLimit(rule, a)).ok, true)
    assert.equal((await rateLimit(rule, a)).ok, false)
    assert.equal((await rateLimit(rule, b)).ok, true, 'one caller exhausted another caller’s budget')
  })

  it('counts each bucket separately', async () => {
    const who = identity()

    assert.equal((await rateLimit({ bucket, limit: 1, windowSec: 60 }, who)).ok, true)
    assert.equal((await rateLimit({ bucket, limit: 1, windowSec: 60 }, who)).ok, false)
    assert.equal(
      (await rateLimit({ bucket: `${bucket}:other`, limit: 1, windowSec: 60 }, who)).ok,
      true,
      'buckets share a counter',
    )
  })

  it('rolls the window and lets the caller through again', async () => {
    // A four-second window observes the roll without sleeping for minutes; the
    // arithmetic is identical at 3600. The waits are anchored to the *database*
    // clock and start of a fresh window, because a round trip to a hosted
    // Postgres is hundreds of milliseconds and two calls either side of a
    // boundary would otherwise look like a broken limiter.
    const rule = { bucket, limit: 1, windowSec: 4 }
    const who = identity()

    await sleep(await msUntilNextWindow(rule.windowSec))

    assert.equal((await rateLimit(rule, who)).ok, true)
    assert.equal((await rateLimit(rule, who)).ok, false, 'the second call in a window was allowed')

    await sleep(await msUntilNextWindow(rule.windowSec))

    assert.equal((await rateLimit(rule, who)).ok, true, 'the window never rolled')

    const [row] = await db.execute<{ n: number; count: number }>(sql`
      SELECT count(*)::int AS n, max("count")::int AS count
        FROM rate_limits WHERE bucket = ${bucket} AND identity = ${who}
    `)
    assert.equal(row?.n, 1, 'the roll left a second row behind')
    assert.equal(row?.count, 1, 'the count restarted at one rather than accumulating')
  })

  it('boundaries are aligned to the clock, not to first contact', async () => {
    // Every serverless instance must agree on where the window starts without
    // agreeing on the time. Flooring epoch/windowSec in Postgres is what makes
    // that true, and it means window_start is always a multiple of the window.
    const rule = { bucket, limit: 5, windowSec: 60 }
    const who = identity()
    await rateLimit(rule, who)

    const [row] = await db.execute<{ aligned: boolean; ahead: number }>(sql`
      SELECT (extract(epoch FROM window_start)::bigint % 60) = 0 AS aligned,
             extract(epoch FROM expires_at - window_start)::int AS ahead
        FROM rate_limits WHERE bucket = ${bucket} AND identity = ${who}
    `)

    assert.equal(row?.aligned, true, 'window_start is not on a 60s boundary')
    assert.equal(row?.ahead, 60, 'expires_at is not one window after window_start')
  })

  it('reports a Retry-After a client can actually use', async () => {
    const rule = { bucket, limit: 1, windowSec: 60 }
    const who = identity()
    await rateLimit(rule, who)

    const blocked = await rateLimit(rule, who)
    assert.equal(blocked.ok, false)
    assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 60, `${blocked.retryAfterSec}`)

    const res = tooManyRequests(blocked)
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), String(blocked.retryAfterSec))
    assert.match(res.headers.get('cache-control') ?? '', /no-store/)
  })

  it('purges only counters whose window closed long ago', async () => {
    const who = identity()
    await rateLimit({ bucket, limit: 5, windowSec: 60 }, who)

    // A live counter must survive, or a caller sitting at the limit could reset
    // their budget by pausing.
    await purgeExpiredRateLimits(0)
    const [live] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM rate_limits WHERE bucket = ${bucket} AND identity = ${who}
    `)
    assert.equal(live?.n, 1, 'the sweeper deleted a counter that was still in use')

    await db.execute(sql`
      UPDATE rate_limits SET expires_at = now() - interval '2 days'
       WHERE bucket = ${bucket} AND identity = ${who}
    `)

    assert.ok((await purgeExpiredRateLimits(3600)) >= 1)
    const [gone] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM rate_limits WHERE bucket = ${bucket} AND identity = ${who}
    `)
    assert.equal(gone?.n, 0)
  })

  it('reads the client address the way a proxy presents it', () => {
    const from = (headers: Record<string, string>) =>
      clientIdentity(new Request('https://example.test/', { headers }))

    // The client is the first entry; the rest are the proxies it passed through.
    assert.equal(from({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' }), '203.0.113.9')
    assert.equal(from({ 'x-forwarded-for': '  203.0.113.9  ' }), '203.0.113.9')
    assert.equal(from({ 'x-real-ip': '203.0.113.9' }), '203.0.113.9')
    // Never empty: an unidentifiable caller must still land in some bucket
    // rather than skipping the limiter entirely.
    assert.equal(from({}), 'unknown')
    assert.ok(from({ 'x-forwarded-for': 'a'.repeat(200) }).length <= 64, 'identity is truncated')
  })

  it('the shipped budgets are the ones the routes think they are', () => {
    assert.deepEqual(RULES.events, { bucket: 'events', limit: 300, windowSec: 60 })
    assert.deepEqual(RULES.login, { bucket: 'auth:login', limit: 20, windowSec: 300 })
    assert.deepEqual(RULES.register, { bucket: 'auth:register', limit: 10, windowSec: 3600 })
  })
})
