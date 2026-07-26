/**
 * Slug generation, with emphasis on Indic scripts.
 *
 *   npm run check:slug
 *
 * A naive `[^\p{L}\p{N}]` filter strips combining marks, which silently
 * destroys Gujarati and Hindi titles — the majority of this platform's library.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { slugify, uniqueSlug } from '../src/lib/slug.ts'

function expect(input: string, want: string) {
  it(`"${input}" → "${want}"`, () => {
    assert.equal(slugify(input), want)
  })
}

describe('Gujarati', () => {
  expect('મારી ફિલ્મ', 'મારી-ફિલ્મ')
  expect('ગુજરાતી ટૂંકી ફિલ્મ', 'ગુજરાતી-ટૂંકી-ફિલ્મ')
})

describe('Hindi', () => {
  expect('मेरी फ़िल्म', 'मेरी-फ़िल्म')
  expect('हिंदी वेब सीरीज़', 'हिंदी-वेब-सीरीज़')
})

describe('Latin', () => {
  expect('My Short Film!! (2026)', 'my-short-film-2026')
  expect('  leading and trailing  ', 'leading-and-trailing')
  expect('multiple---separators', 'multiple-separators')
  expect('Episode 12', 'episode-12')
})

describe('degenerate input', () => {
  it('a punctuation-only title slugifies to empty', () => {
    assert.equal(slugify('!!!'), '')
  })

  it('an empty slug falls back to "video"', () => {
    assert.ok(uniqueSlug('!!!').startsWith('video-'), uniqueSlug('!!!'))
  })

  it('a slug is capped at 160 characters', () => {
    const long = slugify('a'.repeat(400))
    assert.ok(long.length <= 160, `${long.length} chars`)
    assert.ok(!long.endsWith('-'), 'the length cap never leaves a trailing separator')
  })
})

describe('matras survive', () => {
  // The specific failure this file exists to prevent.
  it('Gujarati vowel signs and virama are preserved', () => {
    const gujarati = slugify('મારી ફિલ્મ')
    assert.ok(
      gujarati.includes('ા') && gujarati.includes('ી') && gujarati.includes('્'),
      gujarati,
    )
  })

  it('Devanagari matras are preserved', () => {
    assert.ok(slugify('मेरी').includes('े') && slugify('मेरी').includes('ी'), slugify('मेरी'))
  })
})

describe('uniqueness', () => {
  it('uniqueSlug does not collide across 500 identical titles', () => {
    const slugs = new Set(Array.from({ length: 500 }, () => uniqueSlug('Trailer')))
    assert.equal(slugs.size, 500)
    assert.ok(
      [...slugs].every((s) => /^trailer-[0-9a-f]{6}$/.test(s)),
      'uniqueSlug has the expected shape',
    )
  })
})
