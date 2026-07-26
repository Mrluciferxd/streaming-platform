import { env } from '@/lib/env'

/**
 * Playback tokens.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 * ---------------------------------------------------------------------------
 *
 * The plan has a conflict between §0 and §11 that is easy to miss and expensive
 * to discover in production.
 *
 * §0's economics depend on Cloudflare's CDN absorbing nearly all segment
 * requests so R2 is rarely touched. §11 asks for "time-limited, IP-bound
 * tokens" on playback URLs. The obvious implementation — sign every segment
 * URL per session — satisfies §11 and destroys §0:
 *
 *   /v/abc/720p/seg_00001.m4s?token=<unique-per-session>
 *
 * Every viewer requests a different URL for the same bytes. Different URL means
 * a different cache key, which means a cache miss, which means a Class B read
 * against R2 and an origin fetch. At the 10k DAU scenario that turns a ~$49/mo
 * read bill into several hundred dollars, adds latency to every segment, and
 * removes the edge caching the whole architecture is built on.
 *
 * So: the token goes in a COOKIE, not the query string.
 *
 *   - Cloudflare does not include cookies in the cache key by default, so every
 *     viewer hits the same cache entry for the same segment.
 *   - The app sets the cookie on the parent domain (Domain=.example.com) so the
 *     browser sends it to cdn.example.com automatically. This requires the CDN
 *     hostname to be a subdomain of the app's domain. Plan accordingly when
 *     buying the domain — retrofitting means re-cutting every URL you've
 *     published.
 *   - A Worker on the CDN route verifies the signature and rejects unsigned
 *     requests. See infra/cloudflare/playback-gate.worker.js.
 *
 * The token is scoped to a session, not to a video or a segment. That is a
 * deliberate limit: it stops hotlinking and casual scraping, which is what
 * plan §11 actually asks for ("make casual scraping annoying enough that it
 * isn't worth doing"). It does not stop a determined user re-sharing their own
 * cookie, and no cache-friendly scheme can. If leaks become a real problem the
 * answer is forensic watermarking or DRM, not per-segment signing.
 */

const TOKEN_VERSION = 'v1'

const encoder = new TextEncoder()
let keyPromise: Promise<CryptoKey> | null = null

function hmacKey(): Promise<CryptoKey> {
  keyPromise ??= crypto.subtle.importKey(
    'raw',
    encoder.encode(env.PLAYBACK_TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  return keyPromise
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64url')
}

export type PlaybackTokenClaims = {
  /** Opaque session identifier. Not a user id — anonymous viewers get one too. */
  sid: string
  /** Unix seconds. */
  exp: number
}

/**
 * Payload is signed as a compact string rather than JSON so the Worker can
 * verify it without a JSON parse on the hot path.
 */
function payloadOf(claims: PlaybackTokenClaims): string {
  return `${TOKEN_VERSION}.${claims.sid}.${claims.exp}`
}

export async function issuePlaybackToken(sessionId: string): Promise<{
  token: string
  expiresAt: Date
}> {
  const exp = Math.floor(Date.now() / 1000) + env.PLAYBACK_TOKEN_TTL_SEC
  const claims: PlaybackTokenClaims = { sid: sessionId, exp }
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(), encoder.encode(payloadOf(claims)))

  return {
    token: `${payloadOf(claims)}.${base64UrlEncode(signature)}`,
    expiresAt: new Date(exp * 1000),
  }
}

export async function verifyPlaybackToken(token: string): Promise<PlaybackTokenClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 4) return null

  const [version, sid, expRaw, signature] = parts
  if (version !== TOKEN_VERSION || !sid || !expRaw || !signature) return null

  const exp = Number(expRaw)
  if (!Number.isSafeInteger(exp) || exp * 1000 <= Date.now()) return null

  // crypto.subtle.verify is constant-time, so no separate timing-safe compare.
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(),
    Buffer.from(signature, 'base64url'),
    encoder.encode(`${version}.${sid}.${exp}`),
  )

  return ok ? { sid, exp } : null
}

export const PLAYBACK_COOKIE = 'pb'

/**
 * Cookie attributes for the playback token.
 *
 * `domain` must be the registrable parent of both the app host and the CDN
 * host (".example.com") so the browser attaches it to CDN requests.
 * `path: '/v/'` keeps it off every other request on the site.
 */
export function playbackCookieOptions(expiresAt: Date) {
  return {
    name: PLAYBACK_COOKIE,
    path: '/v/',
    domain: process.env.PLAYBACK_COOKIE_DOMAIN,
    httpOnly: true,
    secure: true,
    // Must be 'lax' rather than 'strict': the CDN is a different host, and
    // 'strict' would withhold the cookie on the very requests it exists for.
    sameSite: 'lax' as const,
    expires: expiresAt,
  }
}
