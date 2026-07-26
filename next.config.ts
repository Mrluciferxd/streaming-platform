import type { NextConfig } from 'next'

/**
 * Security headers.
 *
 * CSP is deliberately strict on `default-src`. The player needs `media-src` and
 * `connect-src` pointed at the CDN host (hls.js fetches segments via XHR/fetch,
 * so the CDN must be in `connect-src`, not just `media-src`).
 */
const cdnOrigin = process.env.NEXT_PUBLIC_CDN_URL ?? ''

const csp = [
  `default-src 'self'`,
  `base-uri 'self'`,
  `frame-ancestors 'none'`,
  `object-src 'none'`,
  `img-src 'self' data: blob: ${cdnOrigin}`,
  `media-src 'self' blob: ${cdnOrigin}`,
  `connect-src 'self' ${cdnOrigin}`,
  `font-src 'self'`,
  // 'unsafe-inline' for styles is required by Next's inlined critical CSS.
  `style-src 'self' 'unsafe-inline'`,
  `script-src 'self' 'unsafe-inline'`,
  `worker-src 'self' blob:`,
]
  .join('; ')
  .replace(/\s+/g, ' ')
  .trim()

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  experimental: {
    // TypeScript 7 is the native (Go) compiler and no longer exposes the JS
    // compiler API Next.js reaches for by default. This routes type checking
    // through the `tsc` CLI instead. Drop it if the project ever pins TS 6.
    useTypeScriptCli: true,
  },

  images: {
    // Thumbnails come off the CDN. AVIF first, WebP fallback (plan §8).
    formats: ['image/avif', 'image/webp'],
    remotePatterns: cdnOrigin
      ? [{ protocol: 'https', hostname: new URL(cdnOrigin).hostname }]
      : [],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ]
  },
}

export default nextConfig
