import { randomBytes } from 'node:crypto'

/**
 * URL slug from a title.
 *
 * `\p{M}` — combining marks — matters as much as `\p{L}` here. Indic vowel
 * signs (matras) are non-spacing marks, so a letters-and-digits-only filter
 * turns "મારી ફિલ્મ" into "મ-ર-ફ-લ-મ": every matra stripped, the word
 * unreadable. On a platform whose differentiator is regional-language content,
 * that would mangle the majority of URLs.
 *
 * NFC, not NFKD: NFKD decomposes each syllable into base plus marks, and NFKC
 * folds visually distinct characters together.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
    // A trailing separator can survive the length cap.
    .replace(/-+$/, '')
}

/**
 * Slug plus a short random suffix.
 *
 * Uniqueness comes from the suffix rather than a lookup-and-retry loop: two
 * creators uploading "Trailer" on the same day is normal, and a database round
 * trip per attempt races anyway under concurrent uploads.
 */
export function uniqueSlug(title: string): string {
  return `${slugify(title) || 'video'}-${randomBytes(3).toString('hex')}`
}
