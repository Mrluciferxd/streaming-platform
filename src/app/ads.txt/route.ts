import { buildAdsTxt } from '@/lib/ads/ads-txt'

/**
 * /ads.txt — the IAB authorised-sellers file (plan §7 MVP).
 *
 * Static: the content is fixed at build time, and a file crawled daily by every
 * exchange should not be a function invocation.
 */
export const dynamic = 'force-static'

export function GET() {
  const body = buildAdsTxt()

  // No configured sellers means no file. See src/lib/ads/ads-txt.ts.
  if (!body) return new Response(null, { status: 404 })

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Crawlers re-read roughly daily. A day at the edge, and a stale copy is
      // always better than a 5xx — an unreachable ads.txt is treated by some
      // buyers as "no authorised sellers".
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    },
  })
}
