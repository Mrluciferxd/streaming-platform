import type { Metadata, Viewport } from 'next'

import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Streaming Platform',
    template: '%s · Streaming Platform',
  },
  description: 'Regional-language video streaming, free to watch.',
  // Organic search is the largest traffic source for this model (plan §4), so
  // every page ships real metadata from day one rather than as a launch task.
  openGraph: { type: 'website', locale: 'en_IN' },
  twitter: { card: 'summary_large_image' },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const cdn = process.env.NEXT_PUBLIC_CDN_URL

  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        {/* Shaves a full TLS handshake off time-to-first-frame (plan §8). */}
        {cdn ? (
          <>
            <link rel="preconnect" href={cdn} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={cdn} />
          </>
        ) : null}
      </head>
      <body className="min-h-dvh bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
