/**
 * Display formatters shared by server and client components.
 *
 * These live outside the component files on purpose: a `'use client'` module
 * can only export components and props across the boundary, so a plain helper
 * exported from one is unusable in a server component.
 */

/** Runtime as a catalogue would show it: "1h 42m", not "1:42:07". */
export function formatRuntime(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)

  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${total}s`
}

/** IT Rules 2021 classifications, in the form viewers actually read. */
export function formatRating(rating: string): string {
  return rating.startsWith('UA') ? `U/A ${rating.slice(2)}+` : rating
}

export function languageLabel(code: string): string {
  const names: Record<string, string> = {
    hi: 'Hindi',
    gu: 'Gujarati',
    en: 'English',
    mr: 'Marathi',
    ta: 'Tamil',
    te: 'Telugu',
    bn: 'Bengali',
    pa: 'Punjabi',
    kn: 'Kannada',
    ml: 'Malayalam',
  }
  return names[code] ?? code.toUpperCase()
}
