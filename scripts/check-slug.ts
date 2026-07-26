/**
 * Slug generation, with emphasis on Indic scripts.
 *
 *   npx tsx scripts/check-slug.ts
 *
 * A naive `[^\p{L}\p{N}]` filter strips combining marks, which silently
 * destroys Gujarati and Hindi titles — the majority of this platform's library.
 */
import { slugify, uniqueSlug } from '../src/lib/slug.ts'

let failures = 0

function check(ok: boolean, label: string, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

function expect(input: string, want: string) {
  const got = slugify(input)
  check(got === want, `"${input}" → "${want}"`, got === want ? '' : `got "${got}"`)
}

// --- Gujarati ---------------------------------------------------------------
expect('મારી ફિલ્મ', 'મારી-ફિલ્મ')
expect('ગુજરાતી ટૂંકી ફિલ્મ', 'ગુજરાતી-ટૂંકી-ફિલ્મ')

// --- Hindi ------------------------------------------------------------------
expect('मेरी फ़िल्म', 'मेरी-फ़िल्म')
expect('हिंदी वेब सीरीज़', 'हिंदी-वेब-सीरीज़')

// --- Latin ------------------------------------------------------------------
expect('My Short Film!! (2026)', 'my-short-film-2026')
expect('  leading and trailing  ', 'leading-and-trailing')
expect('multiple---separators', 'multiple-separators')
expect('Episode 12', 'episode-12')

// --- Degenerate -------------------------------------------------------------
check(slugify('!!!') === '', 'punctuation-only title slugifies to empty')
check(uniqueSlug('!!!').startsWith('video-'), 'empty slug falls back to "video"', uniqueSlug('!!!'))

const long = slugify('a'.repeat(400))
check(long.length <= 160, 'slug is capped at 160 characters', `${long.length} chars`)
check(!long.endsWith('-'), 'the length cap never leaves a trailing separator')

// --- Matras survive ---------------------------------------------------------
// The specific failure this file exists to prevent.
const gujarati = slugify('મારી ફિલ્મ')
check(
  gujarati.includes('ા') && gujarati.includes('ી') && gujarati.includes('્'),
  'Gujarati vowel signs and virama are preserved',
  gujarati,
)
check(
  slugify('मेरी').includes('े') && slugify('मेरी').includes('ी'),
  'Devanagari matras are preserved',
  slugify('मेरी'),
)

// --- Uniqueness -------------------------------------------------------------
const slugs = new Set(Array.from({ length: 500 }, () => uniqueSlug('Trailer')))
check(slugs.size === 500, 'uniqueSlug does not collide across 500 identical titles', `${slugs.size}/500`)
check(
  [...slugs].every((s) => /^trailer-[0-9a-f]{6}$/.test(s)),
  'uniqueSlug has the expected shape',
)

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
