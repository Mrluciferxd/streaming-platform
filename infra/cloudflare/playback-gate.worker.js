/**
 * Cloudflare Worker: playback gate.
 *
 * Deploy on a route covering the CDN hostname's video prefix, e.g.
 *   cdn.example.com/v/*
 *
 * It verifies the `pb` cookie the app sets (src/lib/video/token.ts) and blocks
 * unsigned requests — hotlinking and casual scraping — without ever putting a
 * token in the URL.
 *
 * THE CACHE RULE
 * --------------
 * Everything about this design exists to keep one property true: the cache key
 * is the URL and nothing else. Every viewer requests the identical URL for a
 * given segment, so the first request populates the edge cache and the rest are
 * served from it. R2 is barely touched, which is what makes the §0 economics
 * work (~$75/mo instead of ~$12,000).
 *
 * Concretely, do NOT:
 *   - move the token into a query parameter
 *   - add the cookie to the cache key via a Cache Key custom rule
 *   - vary the response on Authorization, Cookie, or User-Agent
 *
 * Any of those makes the cache key per-viewer, collapses the hit ratio to ~0%,
 * and turns every segment into a Class B read plus an origin fetch.
 *
 * Set PLAYBACK_TOKEN_SECRET as a Worker secret. It must match the app's.
 */

const TOKEN_VERSION = 'v1'
const encoder = new TextEncoder()

/**
 * Keyed by the secret, not a single slot. `env` arrives per-request in the
 * Workers runtime, so a bare memo would pin the first secret an isolate ever
 * saw — and during a rotation the isolate would go on honouring tokens signed
 * with the old secret, which is precisely what rotating is meant to stop.
 */
const keyCache = new Map()

async function hmacKey(secret) {
  let key = keyCache.get(secret)
  if (!key) {
    key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    keyCache.set(secret, key)
  }
  return key
}

function readCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/**
 * Exported so it can be checked against the app's issuer. These two
 * implementations live in different files and different runtimes; if their
 * token formats ever drift, every segment request 403s and playback dies
 * platform-wide. Keep scripts/check-token-interop.js passing.
 */
export async function verifyPlaybackToken(token, secret) {
  if (!token) return false

  const parts = token.split('.')
  if (parts.length !== 4) return false

  const [version, sid, expRaw, signature] = parts
  if (version !== TOKEN_VERSION) return false

  const exp = Number(expRaw)
  if (!Number.isSafeInteger(exp) || exp * 1000 <= Date.now()) return false

  try {
    return await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      base64UrlToBytes(signature),
      encoder.encode(`${version}.${sid}.${exp}`),
    )
  } catch {
    return false
  }
}

export default {
  async fetch(request, env, ctx) {
    // Range requests and conditional GETs must pass through untouched — the
    // player relies on both, and rewriting them breaks seeking.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const token = readCookie(request.headers.get('Cookie'), 'pb')

    if (!(await verifyPlaybackToken(token, env.PLAYBACK_TOKEN_SECRET))) {
      return new Response('Forbidden', {
        status: 403,
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    // Pass through to the R2 origin. The cache key is the request URL — the
    // cookie is not part of it, which is the entire point.
    const response = await fetch(request, {
      cf: {
        cacheEverything: true,
        // VOD segments and playlists are immutable; a re-encode writes to a new
        // video id rather than overwriting.
        cacheTtl: 31536000,
      },
    })

    // Strip Set-Cookie from cached media responses so a stray origin cookie can
    // never be served to the wrong viewer out of the shared cache.
    const out = new Response(response.body, response)
    out.headers.delete('Set-Cookie')
    out.headers.set('Access-Control-Allow-Origin', env.APP_ORIGIN ?? '*')
    out.headers.set('Timing-Allow-Origin', env.APP_ORIGIN ?? '*')

    return out
  },
}
