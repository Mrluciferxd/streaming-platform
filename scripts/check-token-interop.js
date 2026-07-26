/**
 * Confirms the edge Worker accepts exactly what the app issues.
 *
 * The signer lives in src/lib/video/token.ts (Node) and the verifier in
 * infra/cloudflare/playback-gate.worker.js (Workers runtime). They are separate
 * files that can drift independently, and a drift is not subtle in production:
 * every segment request 403s and nothing plays anywhere.
 *
 * Run against a live dev server:
 *   node scripts/check-token-interop.js http://localhost:3000
 */
import { verifyPlaybackToken } from '../infra/cloudflare/playback-gate.worker.js'

const base = process.argv[2] ?? 'http://localhost:3000'
const secret = process.env.PLAYBACK_TOKEN_SECRET

if (!secret) {
  console.error('PLAYBACK_TOKEN_SECRET must be set, and must match the app’s.')
  process.exit(1)
}

const res = await fetch(`${base}/api/tokencheck`)
if (!res.ok) {
  console.error(`Could not reach ${base}/api/tokencheck (HTTP ${res.status})`)
  process.exit(1)
}

const { token } = await res.json()

const cases = [
  ['app-issued token accepted by worker', await verifyPlaybackToken(token, secret), true],
  [
    'tampered signature rejected',
    await verifyPlaybackToken(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), secret),
    false,
  ],
  ['wrong secret rejected', await verifyPlaybackToken(token, secret + 'x'), false],
  ['expired token rejected', await verifyPlaybackToken('v1.abc.1000000000.aGVsbG8', secret), false],
  ['malformed token rejected', await verifyPlaybackToken('garbage', secret), false],
  ['missing token rejected', await verifyPlaybackToken(null, secret), false],
]

let failed = 0
for (const [name, actual, expected] of cases) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

process.exit(failed === 0 ? 0 : 1)
