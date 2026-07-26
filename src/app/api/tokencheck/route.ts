import { NextResponse } from 'next/server'
import { isProd } from '@/lib/env'
import { issuePlaybackToken, verifyPlaybackToken } from '@/lib/video/token'

export const dynamic = 'force-dynamic'

/**
 * Development-only. Exercises the playback token round-trip and hands out a
 * real token so scripts/check-token-interop.js can confirm the edge Worker
 * accepts it. Returns 404 in production — this endpoint mints valid playback
 * tokens on request, which is fine locally and a bypass anywhere else.
 */
export async function GET() {
  if (isProd) return new NextResponse('Not Found', { status: 404 })

  const sid = '11111111-2222-3333-4444-555555555555'
  const { token, expiresAt } = await issuePlaybackToken(sid)

  const good = await verifyPlaybackToken(token)
  const tampered = await verifyPlaybackToken(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))
  const wrongSid = await verifyPlaybackToken(token.replace(sid, '99999999-2222-3333-4444-555555555555'))
  const expired = await verifyPlaybackToken('v1.abc.1000000000.aGVsbG8')
  const malformed = await verifyPlaybackToken('garbage')

  return NextResponse.json({
    token,
    expiresAt,
    validAccepted: good?.sid === sid,
    tamperedRejected: tampered === null,
    wrongSidRejected: wrongSid === null,
    expiredRejected: expired === null,
    malformedRejected: malformed === null,
  })
}
