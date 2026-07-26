import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://streaming-platform-red.vercel.app')
    .replace(/\/+$/, '')

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          // Never useful to index, and /api/* would burn crawl budget on JSON.
          '/api/',
          // Thin, near-duplicate pages that dilute the ones meant to rank.
          '/search',
          // Placeholder policies — see src/app/legal/[slug]/page.tsx.
          '/legal/',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  }
}
