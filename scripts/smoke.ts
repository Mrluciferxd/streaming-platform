/**
 * End-to-end smoke test against a running deployment.
 *
 *   npm run smoke -- https://streaming-platform-red.vercel.app
 *
 * Deliberately black-box: it knows the URLs and the contracts, not the
 * database. It walks the paths a real visit takes — catalogue, sitemap, a watch
 * page, the playback endpoint, sign-up, list, resume position, sign-out — plus
 * the three places where being wrong is expensive: telemetry validation, cron
 * auth, and upload auth.
 *
 * The URL is required rather than defaulted, because this registers an account
 * and writes playback events. Both are cleaned up afterwards when DATABASE_URL
 * is set; when it is not, the leftovers are printed rather than left silent.
 *
 * Exits non-zero on any failure — this is meant to gate a deploy.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import postgres from 'postgres'

const base = (
  process.env.SMOKE_BASE_URL ?? process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? ''
).replace(/\/+$/, '')

if (!base) {
  console.error('Usage: npm run smoke -- https://host   (or SMOKE_BASE_URL=…)')
  process.exit(2)
}

const run = crypto.randomUUID().slice(0, 8)
const account = {
  // .example is reserved by RFC 2606, so a stray mail to it can never reach a
  // real person even if one of these rows escapes cleanup.
  email: `smoke+${run}@smoke.example`,
  password: `smoke-${crypto.randomUUID()}`,
  displayName: `Smoke ${run}`,
}
const eventSession = crypto.randomUUID()

/** Cookie jar. Node's fetch has none, and the whole session leg needs one. */
const jar = new Map<string, string>()

function absorb(res: Response) {
  for (const cookie of res.headers.getSetCookie()) {
    const pair = cookie.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await fetch(`${base}${path}`, {
    ...init,
    // Manual, so a redirect is something to assert on rather than something
    // that silently turns a 401 into a 200 page.
    redirect: 'manual',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  })
  absorb(res)
  return res
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

/** Discovered from the sitemap and the playback API, so there are no fixtures. */
let slug = ''
let videoId = ''
let title = ''
let durationSec = 0
let resumeAt = 0
let resumeAgainAt = 0

/** Continue Watching hides anything below this — see src/app/api/history. */

describe('public pages', () => {
  it('serves the homepage as HTML', async () => {
    const res = await req('/')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await res.text(), /<html/i)
  })

  it('serves a sitemap of absolute URLs', async () => {
    const res = await req('/sitemap.xml')
    assert.equal(res.status, 200)

    const xml = await res.text()
    assert.match(xml, /<urlset/)

    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
    assert.ok(locs.length > 0, 'the sitemap is empty')
    // Relative URLs in a sitemap are rejected wholesale by search engines, and
    // nothing else in the system would ever notice.
    assert.ok(
      locs.every((loc) => loc.startsWith('https://')),
      'every <loc> must be absolute',
    )

    slug = locs.find((loc) => loc.includes('/watch/'))?.split('/watch/')[1] ?? ''
    assert.ok(slug, 'no published watch page in the sitemap')
  })

  it('serves robots.txt with the crawl rules that matter', async () => {
    const res = await req('/robots.txt')
    assert.equal(res.status, 200)

    const body = await res.text()
    assert.match(body, /Sitemap:\s*https:\/\//)
    assert.match(body, /Disallow:\s*\/api\//)
    // Placeholder policies must stay out of the index — see src/app/legal.
    assert.match(body, /Disallow:\s*\/legal\//)
  })

  it('serves a category page', async () => {
    const res = await req('/c/action')
    assert.equal(res.status, 200)
  })

  it('serves the watch page for a published title', async () => {
    const res = await req(`/watch/${slug}`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /<html/i)
  })

  it('404s an unknown path', async () => {
    assert.equal((await req(`/no-such-page-${run}`)).status, 404)
  })

  it('serves every legal page and 404s an unknown one', async () => {
    for (const doc of ['terms', 'privacy', 'copyright', 'grievance']) {
      assert.equal((await req(`/legal/${doc}`)).status, 200, `/legal/${doc}`)
    }
    assert.equal((await req('/legal/nonsense')).status, 404)
  })

  it('reports healthy', async () => {
    const res = await req('/api/health')
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.checks?.database, 'ok')
  })
})

describe('playback', () => {
  it('hands the player a source and the playback cookie', async () => {
    const res = await req(`/api/playback/${slug}`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.match(body.videoId ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(body.slug, slug)
    assert.ok(body.source?.masterUrl, 'no master playlist URL')

    // The `pb` cookie is the authorisation for every segment request. Without
    // it the CDN gate 403s everything and nothing plays anywhere.
    assert.ok(jar.has('pb'), 'no playback cookie was set')

    videoId = body.videoId
    title = body.title
    durationSec = body.durationSec

    assert.ok(durationSec > 0, `${slug} has no duration`)
  })

  it('404s an unknown slug', async () => {
    assert.equal((await req(`/api/playback/nope-${run}`)).status, 404)
  })
})

describe('accounts', () => {
  it('redirects a signed-out visitor away from My List', async () => {
    const res = await req('/my-list')
    assert.equal(res.status, 307)
    assert.match(res.headers.get('location') ?? '', /\/account/)
  })

  it('refuses the watchlist without a session', async () => {
    assert.equal((await req('/api/watchlist')).status, 401)
  })

  it('rejects a registration that fails the password or consent rules', async () => {
    const res = await req('/api/auth/register', json({ ...account, password: 'short' }))
    assert.equal(res.status, 400)
  })

  it('registers an account and sets a hardened session cookie', async () => {
    const res = await req('/api/auth/register', json({ ...account, consent: true }))

    // Read once: a Response body cannot be consumed twice, and the failure
    // message is more useful than the status alone.
    const text = await res.text()
    assert.equal(res.status, 200, text)

    const body = JSON.parse(text)
    assert.equal(body.ok, true)
    assert.match(body.userId ?? '', /^[0-9a-f-]{36}$/)

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sid_auth='))
    assert.ok(cookie, 'no session cookie')
    // A session cookie readable from JavaScript turns any XSS into account
    // takeover; SameSite=Lax is what stops a cross-site POST riding the session.
    assert.match(cookie, /HttpOnly/i)
    assert.match(cookie, /SameSite=Lax/i)
    if (base.startsWith('https://')) assert.match(cookie, /Secure/i)
  })

  it('does not confirm that an address is already registered', async () => {
    const res = await req('/api/auth/register', json({ ...account, consent: true }))
    assert.equal(res.status, 409)

    // The 409 must not become an account-enumeration oracle.
    const body = (await res.text()).toLowerCase()
    assert.ok(!body.includes('already'), body)
    assert.ok(!body.includes(account.email.toLowerCase()), body)
  })

  it('lets the signed-in viewer reach My List', async () => {
    assert.equal((await req('/my-list')).status, 200)
  })

  it('adds and removes a title on the watchlist', async () => {
    const added = await req('/api/watchlist', json({ videoId }))
    assert.equal(added.status, 200)
    assert.equal((await added.json()).inList, true)

    const listed = await req('/api/watchlist')
    assert.equal(listed.status, 200)
    // A personalised response in a shared cache is served to the wrong viewer.
    assert.match(listed.headers.get('cache-control') ?? '', /no-store/)

    const items = (await listed.json()).items as Array<{ id: string; title: string }>
    assert.ok(
      items.some((i) => i.id === videoId),
      'the added title is not in the list',
    )
    assert.equal(items.find((i) => i.id === videoId)?.title, title)

    const removed = await req('/api/watchlist', {
      method: 'DELETE',
      body: JSON.stringify({ videoId }),
    })
    assert.equal(removed.status, 200)

    const after = (await (await req('/api/watchlist')).json()).items as Array<{ id: string }>
    assert.ok(!after.some((i) => i.id === videoId), 'the title was not removed')
  })

  it('rejects a malformed watchlist body', async () => {
    assert.equal((await req('/api/watchlist', json({ videoId: 'nope' }))).status, 400)
  })

  it('records a resume position and reads it back', async () => {
    /**
     * The position must land inside the band Continue Watching shows: past the
     * resume floor and short of the 95% that counts as finished.
     *
     * Derived from the runtime rather than pinned to the absolute floor. The
     * previous form was `max(MIN_RESUME_SECONDS, duration * 0.4)`, which for
     * any clip shorter than the floor produced a position past the end of the
     * video — the server clamps that to the duration, which reads as 100%
     * watched, so the title is "finished" and never appears. The assertion was
     * real; the position it chose was impossible.
     */
    resumeAt = Math.max(1, Math.floor(durationSec * 0.4))
    resumeAgainAt = Math.min(resumeAt + 1, Math.floor(durationSec * 0.9))
    assert.ok(resumeAt < resumeAgainAt, `no usable resume band in ${durationSec}s`)

    const posted = await req('/api/history', json({ videoId, positionSec: resumeAt, durationSec }))
    assert.equal(posted.status, 204)

    const res = await req('/api/history')
    assert.equal(res.status, 200)

    const items = (await res.json()).items as Array<{
      id: string
      positionSec: number
      durationSec: number
      progress: number
    }>
    const entry = items.find((i) => i.id === videoId)
    assert.ok(entry, 'Continue Watching did not return the title')
    assert.equal(entry.positionSec, resumeAt)
    // Progress is computed against the catalogue's duration, not against
    // whatever the client claimed the duration was.
    const expected = Math.min(1, resumeAt / entry.durationSec)
    assert.ok(Math.abs(entry.progress - expected) < 0.001, `progress=${entry.progress}`)
  })

  it('upserts rather than duplicating on a second heartbeat', async () => {
    await req('/api/history', json({ videoId, positionSec: resumeAgainAt, durationSec }))

    const items = (await (await req('/api/history')).json()).items as Array<{
      id: string
      positionSec: number
    }>
    const mine = items.filter((i) => i.id === videoId)
    assert.equal(mine.length, 1, 'a repeated heartbeat inserted a second row')
    assert.equal(mine[0]!.positionSec, resumeAgainAt)
  })

  it('signs out and the session stops working', async () => {
    const res = await req('/api/auth/login', { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.equal((await req('/api/watchlist')).status, 401)
  })

  it('refuses the wrong password', async () => {
    const res = await req('/api/auth/login', json({ email: account.email, password: 'wrong-one' }))
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error, 'invalid_credentials')
  })

  it('signs back in and the viewer keeps their position', async () => {
    const res = await req(
      '/api/auth/login',
      json({ email: account.email, password: account.password }),
    )
    assert.equal(res.status, 200)

    const items = (await (await req('/api/history')).json()).items as Array<{
      id: string
      positionSec: number
    }>
    assert.equal(items.find((i) => i.id === videoId)?.positionSec, resumeAgainAt)
  })
})

describe('telemetry ingest', () => {
  const send = (events: unknown[]) => req('/api/events', json({ events }))

  it('accepts a valid batch', async () => {
    // 'pause'/'seek' rather than 'play': the nightly rollup counts 'play' as a
    // view, and a smoke test must not move the numbers the business reads.
    const res = await send([
      { videoId, sessionId: eventSession, eventType: 'pause', positionSec: 5 },
      { videoId, sessionId: eventSession, eventType: 'seek', positionSec: 9, watchedSec: 4 },
    ])
    assert.equal(res.status, 204)
  })

  it('rejects a malformed batch', async () => {
    const res = await send([{ videoId: 'not-a-uuid', sessionId: eventSession, eventType: 'pause' }])
    assert.equal(res.status, 400)
  })

  it('rejects an oversized batch', async () => {
    const res = await send(
      Array.from({ length: 80 }, () => ({ videoId, sessionId: eventSession, eventType: 'pause' })),
    )
    assert.equal(res.status, 400)
  })

  it('rejects implausible watch time', async () => {
    const res = await send([
      { videoId, sessionId: eventSession, eventType: 'seek', watchedSec: 99_999 },
    ])
    assert.equal(res.status, 400)
  })

  it('drops an unknown event type without failing the batch', async () => {
    const res = await send([{ videoId, sessionId: eventSession, eventType: 'teleport' }])
    assert.equal(res.status, 204)
  })

  it('drops events for videos that do not exist', async () => {
    const res = await send([
      {
        videoId: '00000000-0000-4000-8000-000000000000',
        sessionId: eventSession,
        eventType: 'pause',
      },
    ])
    assert.equal(res.status, 204)
  })
})

describe('privileged endpoints are closed', () => {
  for (const path of ['/api/cron/rollup', '/api/cron/sweep']) {
    it(`${path} refuses an unauthenticated caller`, async () => {
      assert.equal((await req(path)).status, 401)
    })

    it(`${path} refuses a wrong bearer token`, async () => {
      const res = await req(path, { headers: { authorization: 'Bearer not-the-cron-secret' } })
      assert.equal(res.status, 401)
    })
  }

  /**
   * The admin surface answers 404 rather than 401, so that it does not confirm
   * to an anonymous caller which endpoints exist.
   *
   * Asserted as *JSON* 404, not merely status 404: the framework's own 404 page
   * is HTML, so a status check alone would pass identically whether the route
   * is guarded or simply missing — which is precisely the mistake this test
   * exists to catch.
   */
  async function assertRefusedAsNotFound(res: Response, what: string) {
    assert.equal(res.status, 404, what)
    assert.match(
      res.headers.get('content-type') ?? '',
      /application\/json/,
      `${what}: got the HTML 404 page, so the route is missing rather than guarded`,
    )
    assert.equal((await res.clone().json()).error, 'not_found', what)
  }

  const uploadBody = json({
    filename: 'x.mp4',
    contentType: 'video/mp4',
    sizeBytes: 1024,
    title: 'smoke',
  })

  it('upload/create refuses an unauthenticated caller', async () => {
    const res = await req('/api/upload/create', uploadBody)
    await assertRefusedAsNotFound(res, 'upload/create')

    // This endpoint hands out write access to the media bucket; the status code
    // matters less than what must never come back with it.
    const body = await res.text()
    assert.ok(!body.includes('uploadId'), 'an upload was created without credentials')
    assert.ok(!body.includes('X-Amz-Signature'), 'a presigned write URL leaked')
  })

  it('upload/create refuses a bearer token in place of a session', async () => {
    const res = await req('/api/upload/create', {
      ...uploadBody,
      headers: { authorization: 'Bearer not-the-upload-token' },
    })
    await assertRefusedAsNotFound(res, 'upload/create with a bearer token')
    assert.ok(!(await res.text()).includes('uploadId'))
  })

  it('publish-due refuses an unauthenticated caller', async () => {
    // Cron-triggered, but it publishes content — an open trigger would let
    // anyone push a scheduled title live early.
    await assertRefusedAsNotFound(await req('/api/admin/publish-due'), 'publish-due')
  })

  it('publish-due refuses a wrong cron secret', async () => {
    const res = await req('/api/admin/publish-due', {
      headers: { authorization: 'Bearer not-the-cron-secret' },
    })
    await assertRefusedAsNotFound(res, 'publish-due with a wrong bearer')
  })
})

/**
 * The account and the events are real rows in whatever database the deployment
 * points at. Removing them needs SQL, so it happens only when DATABASE_URL is
 * available — and when it is not, the leftovers are named rather than dropped
 * quietly.
 */
after(async () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.log(
      `\nNot cleaning up: DATABASE_URL is unset.\n` +
        `  user  ${account.email}\n` +
        `  events session ${eventSession}\n`,
    )
    return
  }

  const sql = postgres(url, { max: 1 })
  try {
    await sql`DELETE FROM video_events WHERE session_id = ${eventSession}::uuid`
    // Watchlist, history and sessions cascade from the user row.
    const deleted = await sql`DELETE FROM users WHERE email = ${account.email} RETURNING id`
    console.log(`\nCleaned up ${deleted.length} smoke account and its events.`)
  } catch (error) {
    console.error(`\nCleanup failed — remove ${account.email} by hand.`, error)
  } finally {
    await sql.end()
  }
})

// Preconditions are the caller's problem here: a smoke test that skips is a
// smoke test that never fails, which defeats the point of running it on deploy.
before(() => console.log(`Smoking ${base} as ${account.email}\n`))
