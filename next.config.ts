import type { NextConfig } from 'next'

/**
 * Security headers.
 *
 * CSP is deliberately strict on `default-src`. The player needs `media-src` and
 * `connect-src` pointed at the CDN host (hls.js fetches segments via XHR/fetch,
 * so the CDN must be in `connect-src`, not just `media-src`).
 */
const cdnOrigin = process.env.NEXT_PUBLIC_CDN_URL ?? ''
const isDev = process.env.NODE_ENV !== 'production'

/**
 * R2's S3 API endpoint, for the browser upload that PUTs parts straight to the
 * bucket with presigned URLs.
 *
 * This is a different host from the public CDN domain — that one serves the
 * packaged HLS, this one takes the writes — so `connect-src` needs it named
 * explicitly or every part upload is blocked in production while working
 * locally, where there is no CSP on the dev origin to notice.
 *
 * Both forms are listed because which one is used depends on a client setting
 * rather than on anything visible here: the AWS SDK addresses a custom endpoint
 * virtual-hosted style by default (bucket as a subdomain) and path style when
 * `forcePathStyle` is set. Naming both costs nothing and survives that flag
 * being flipped. Absent entirely when R2 is not configured.
 */
const r2AccountId = process.env.R2_ACCOUNT_ID ?? ''
const r2Bucket = process.env.R2_BUCKET ?? ''

const r2Origins = r2AccountId
  ? [
      `https://${r2AccountId}.r2.cloudflarestorage.com`,
      ...(r2Bucket ? [`https://${r2Bucket}.${r2AccountId}.r2.cloudflarestorage.com`] : []),
    ]
  : []

/**
 * Ad hosts (plan §9).
 *
 * Added only when ads are switched on, so an unconfigured deploy keeps exactly
 * the policy it had before advertising existed. Hosts are enumerated rather
 * than wildcarded on `*.google.com` or `*.doubleclick.net`: those two names
 * cover a very large amount of Google, and a CSP that allows all of it is not
 * meaningfully a CSP.
 *
 * Two things keep this list as short as it is. The player uses the IMA SDK,
 * which serves creatives from Google's own media hosts, and display slots run
 * in forced SafeFrame (see src/lib/ads/display.ts) so third-party creatives
 * render inside a cross-origin iframe under Google's policy instead of
 * inheriting this one. Adding a demand partner whose creatives are served from
 * their own CDN — a non-Google video exchange, say — means adding that host to
 * `media` and `img` below; nothing here fails open.
 */
const adsEnabled = process.env.NEXT_PUBLIC_ADS_ENABLED === '1'

const adHosts = {
  script: [
    'https://imasdk.googleapis.com',
    // ima3.js is only a loader: it pulls its implementation from 2mdn, and
    // without this the SDK half-initialises — `google.ima` exists, the API is
    // callable, and no ad request is ever made and no error is ever raised.
    // Verified by watching it fail with this line removed.
    'https://s0.2mdn.net',
    'https://securepubads.g.doubleclick.net',
    'https://pagead2.googlesyndication.com',
  ],
  // IMA renders its ad UI in an iframe; GPT renders every creative in one.
  frame: [
    'https://imasdk.googleapis.com',
    'https://securepubads.g.doubleclick.net',
    'https://googleads.g.doubleclick.net',
    'https://tpc.googlesyndication.com',
    'https://www.google.com',
  ],
  // VAST requests, wrapper unwinding, impression and viewability beacons.
  connect: [
    'https://imasdk.googleapis.com',
    'https://s0.2mdn.net',
    'https://securepubads.g.doubleclick.net',
    'https://pubads.g.doubleclick.net',
    'https://googleads.g.doubleclick.net',
    'https://pagead2.googlesyndication.com',
    'https://www.google.com',
    'https://csi.gstatic.com',
  ],
  img: [
    'https://imasdk.googleapis.com',
    // Also where a large share of DoubleClick creative assets are served from.
    'https://s0.2mdn.net',
    'https://securepubads.g.doubleclick.net',
    'https://googleads.g.doubleclick.net',
    'https://tpc.googlesyndication.com',
    'https://pagead2.googlesyndication.com',
    'https://www.google.com',
    'https://www.gstatic.com',
  ],
  /**
   * Linear creatives play in a video element IMA creates inside this document,
   * so the creative host has to be allowed here — this is the one directive an
   * ad stack genuinely widens.
   */
  media: [
    'https://imasdk.googleapis.com',
    'https://s0.2mdn.net',
    'https://googleads.g.doubleclick.net',
    // Where Google actually delivers video creatives from. Both are needed:
    // which one a given creative resolves to is a routing decision made per
    // request, and a policy with only the obvious one fails intermittently —
    // the worst way for this to fail. Verified by watching a sample tag return
    // a creative on redirector.gvt1.com.
    'https://*.googlevideo.com',
    'https://*.gvt1.com',
    // Google's public IMA sample tags host some creatives here. Test fixtures
    // only, which is why it stays out of the production policy.
    ...(isDev ? ['https://storage.googleapis.com'] : []),
  ],
}

const ads = (directive: keyof typeof adHosts) =>
  adsEnabled ? ` ${adHosts[directive].join(' ')}` : ''

const csp = [
  `default-src 'self'`,
  `base-uri 'self'`,
  `frame-ancestors 'none'`,
  `object-src 'none'`,
  `img-src 'self' data: blob: ${cdnOrigin}${ads('img')}`,
  `media-src 'self' blob: ${cdnOrigin}${ads('media')}`,
  // hls.js fetches segments with XHR/fetch, so the CDN must be in connect-src
  // and not only media-src. The R2 S3 endpoint is here for the direct-to-bucket
  // upload, which is a write to a different host than the CDN serves from.
  `connect-src 'self' ${cdnOrigin}${r2Origins.length > 0 ? ` ${r2Origins.join(' ')}` : ''}${ads('connect')}`,
  `font-src 'self'`,
  // 'unsafe-inline' for styles is required by Next's inlined critical CSS.
  `style-src 'self' 'unsafe-inline'`,
  // 'unsafe-eval' is development only: React's dev build uses eval() to
  // reconstruct call stacks, and Turbopack's HMR runtime needs it. Shipping it
  // to production would undo most of the value of having a CSP at all.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}${ads('script')}`,
  // hls.js runs its demuxer in a worker created from a blob URL.
  `worker-src 'self' blob:`,
  // Only emitted with ads on. Without it frames fall back to default-src 'self',
  // which is the stricter position and the one to keep by default.
  ...(adsEnabled ? [`frame-src 'self'${ads('frame')}`] : []),
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
