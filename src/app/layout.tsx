import type { Metadata, Viewport } from 'next'
import { Baloo_2, Quicksand } from 'next/font/google'

import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'
import './globals.css'

/**
 * Type.
 *
 * next/font downloads these at build time and serves them from our own origin,
 * which is what plan §8 asks for (self-hosted, subset, font-display: swap) and
 * what the `font-src 'self'` CSP requires — a Google Fonts <link> would be
 * blocked outright.
 *
 * Quicksand for body: geometric, rounded, and readable at its lighter weights,
 * which is where the airy feel comes from.
 *
 * Baloo 2 for display, and as the fallback behind Quicksand. It is the chunky
 * rounded voice the headings want, and — unlike most rounded Latin faces — it
 * ships Devanagari, so Hindi titles keep the same voice instead of dropping to
 * a system serif and looking like a different product.
 *
 * Gujarati is a separate family in this set (Baloo Bhai 2). Add it when there
 * is Gujarati content to justify a third font download; until then those titles
 * fall back to the system stack.
 */
const body = Quicksand({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
})

const display = Baloo_2({
  subsets: ['latin', 'devanagari'],
  weight: ['500', '600', '700', '800'],
  // Not `--font-display`: that name belongs to the Tailwind theme token in
  // globals.css, and having the token reference itself would be circular.
  variable: '--font-display-face',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'Anime, free to watch',
    template: '%s · StreamFlix',
  },
  description: 'Stream subbed and dubbed anime series and films. Free, ad-supported.',
  openGraph: { type: 'website', locale: 'en_IN' },
  twitter: { card: 'summary_large_image' },
}

export const viewport: Viewport = {
  themeColor: '#fef7fb',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const cdn = process.env.NEXT_PUBLIC_CDN_URL

  return (
    <html lang="en-IN" className={`${body.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        {/* Shaves a full TLS handshake off time-to-first-frame (plan §8). */}
        {cdn ? (
          <>
            <link rel="preconnect" href={cdn} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={cdn} />
          </>
        ) : null}
      </head>
      <body className="min-h-dvh bg-canvas font-sans text-ink antialiased">
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
