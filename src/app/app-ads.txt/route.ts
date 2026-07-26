import { buildAppAdsTxt } from '@/lib/ads/ads-txt'

/**
 * /app-ads.txt — the same authorisation list for in-app inventory.
 *
 * Off unless ADS_TXT_APP_ADS=1. There is no mobile app yet (plan §7 v3), and
 * publishing the file before there is one authorises sellers for inventory that
 * does not exist.
 */
export const dynamic = 'force-static'

export function GET() {
  const body = buildAppAdsTxt()
  if (!body) return new Response(null, { status: 404 })

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    },
  })
}
