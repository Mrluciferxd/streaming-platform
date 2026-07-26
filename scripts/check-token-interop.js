/**
 * Confirms the edge Worker accepts exactly what the app issues.
 *
 * The signer lives in src/lib/video/token.ts (Node) and the verifier in
 * infra/cloudflare/playback-gate.worker.js (Workers runtime). They are separate
 * files that can drift independently, and a drift is not subtle in production:
 * every segment request 403s and nothing plays anywhere.
 *
 * Run against a live server:
 *   npm run check:token
 *   npm run check:token -- https://host
 *
 * Deliberately plain JavaScript with no local imports beyond the Worker itself,
 * so it runs under bare `node` with no loader — the same way the Workers
 * runtime will see that file.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { verifyPlaybackToken } from '../infra/cloudflare/playback-gate.worker.js'

const base = (
  process.env.CHECK_BASE_URL ??
  process.argv.slice(2).find((arg) => /^https?:\/\//.test(arg)) ??
  'http://localhost:3000'
).replace(/\/+$/, '')

const secret = process.env.PLAYBACK_TOKEN_SECRET

/** A precondition is a reason to skip; CHECK_STRICT=1 makes it a failure. */
function unmet(reason) {
  if (!reason) return false
  if (process.env.CHECK_STRICT === '1') throw new Error(`precondition not met: ${reason}`)
  return reason
}

let token
let reason = secret ? null : 'PLAYBACK_TOKEN_SECRET is not set (and must match the app’s)'

if (!reason) {
  const res = await fetch(`${base}/api/tokencheck`).catch(() => null)
  if (!res?.ok) reason = `could not reach ${base}/api/tokencheck (${res?.status ?? 'no response'})`
  else ({ token } = await res.json())
}

describe('playback token interop', { skip: unmet(reason) }, () => {
  it('accepts an app-issued token', async () => {
    assert.equal(await verifyPlaybackToken(token, secret), true)
  })

  it('rejects a tampered signature', async () => {
    const tampered = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
    assert.equal(await verifyPlaybackToken(tampered, secret), false)
  })

  it('rejects the wrong secret', async () => {
    assert.equal(await verifyPlaybackToken(token, secret + 'x'), false)
  })

  it('rejects an expired token', async () => {
    assert.equal(await verifyPlaybackToken('v1.abc.1000000000.aGVsbG8', secret), false)
  })

  it('rejects a malformed token', async () => {
    assert.equal(await verifyPlaybackToken('garbage', secret), false)
  })

  it('rejects a missing token', async () => {
    assert.equal(await verifyPlaybackToken(null, secret), false)
  })
})
