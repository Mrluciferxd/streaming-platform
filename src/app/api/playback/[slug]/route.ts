import { randomUUID } from 'node:crypto'

import { and, eq, isNull } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { db, videos, videoVariants } from '@/db'
import { isPubliclyVisible } from '@/lib/queries/visibility'
import { getVideoProvider, issuePlaybackToken, playbackCookieOptions } from '@/lib/video'

export const dynamic = 'force-dynamic'

const SESSION_COOKIE = 'sid'

/**
 * Everything the player needs for one video, plus the playback cookie.
 *
 * The cookie is the authorisation for every subsequent segment request. It is
 * deliberately not a signed URL — see src/lib/video/token.ts for why per-segment
 * signing would collapse the CDN cache hit ratio and with it the economics the
 * whole architecture is built on.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.slug, slug), isNull(videos.deletedAt)))
    .limit(1)

  if (!video) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // 'ready' means transcoded but not published. Only an operator action makes
  // something public, so an unpublished video must not be playable by URL.
  if (!isPubliclyVisible(video)) {
    return NextResponse.json({ error: 'not_available', status: video.status }, { status: 404 })
  }

  if (!video.hlsMasterPath) {
    return NextResponse.json({ error: 'no_media' }, { status: 409 })
  }

  const jar = await cookies()

  // Anonymous viewers get a session id too: it binds the playback token and
  // groups analytics events without requiring an account.
  let sessionId = jar.get(SESSION_COOKIE)?.value
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    sessionId = randomUUID()
    jar.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    })
  }

  const provider = await getVideoProvider()
  const source = await provider.getPlaybackSource({
    videoId: video.id,
    hlsMasterPath: video.hlsMasterPath,
    posterPath: video.posterUrl,
    spritePath: video.spriteUrl,
    spriteVttPath: video.spriteVttUrl,
    sessionId,
  })

  const { token, expiresAt } = await issuePlaybackToken(sessionId)
  const cookieOptions = playbackCookieOptions(expiresAt)

  const variants = await db
    .select({
      resolution: videoVariants.resolution,
      width: videoVariants.width,
      height: videoVariants.height,
      bitrateKbps: videoVariants.bitrateKbps,
    })
    .from(videoVariants)
    .where(eq(videoVariants.videoId, video.id))
    .orderBy(videoVariants.height)

  const response = NextResponse.json(
    {
      videoId: video.id,
      slug: video.slug,
      title: video.title,
      durationSec: video.durationSec,
      ageRating: video.ageRating,
      contentDescriptor: video.contentDescriptor,
      source,
      variants,
      sessionId,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )

  response.cookies.set({
    name: cookieOptions.name,
    value: token,
    path: cookieOptions.path,
    // Unset in development, where app and media share an origin.
    ...(cookieOptions.domain ? { domain: cookieOptions.domain } : {}),
    httpOnly: cookieOptions.httpOnly,
    secure: process.env.NODE_ENV === 'production',
    sameSite: cookieOptions.sameSite,
    expires: cookieOptions.expires,
  })

  return response
}
