/**
 * Seeds the category taxonomy.
 *
 * Plan §15.4: settle this early, because the slugs become your URL structure
 * (/c/short-films), your SEO surface, and your homepage rails — and renaming
 * one later means redirects and lost rankings.
 *
 * Ten top-level categories, weighted toward regional-language content since
 * that is the differentiator plan §1 recommends. Adjust before first publish;
 * after that, add rather than rename.
 *
 *   npm run db:seed
 *
 * Deliberately self-contained: it builds its own connection from DATABASE_URL
 * and imports the table definitions by relative path rather than going through
 * src/db/index.ts. That keeps it runnable with plain `node` (no path-alias
 * loader) and means seeding does not require the full R2/Bunny credential set
 * that src/lib/env.ts validates.
 */
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { categories } from '../src/db/schema.ts'

/**
 * Anime genre taxonomy.
 *
 * These are the buckets anime viewers actually browse by, which is not the same
 * set a general video catalogue uses. Isekai and Slice of Life are not
 * sub-genres of anything here — they are top-level destinations, and a viewer
 * looking for one will not find it filed under "Drama".
 *
 * Demographic labels (Shonen, Shojo, Seinen) sit alongside genre labels on
 * purpose: that is how the source industry categorises, and how listings sites
 * present it.
 */
const TAXONOMY = [
  { slug: 'action', name: 'Action', icon: 'swords' },
  { slug: 'isekai', name: 'Isekai', icon: 'portal' },
  { slug: 'shonen', name: 'Shonen', icon: 'flame' },
  { slug: 'romance', name: 'Romance', icon: 'heart' },
  { slug: 'slice-of-life', name: 'Slice of Life', icon: 'sun' },
  { slug: 'fantasy', name: 'Fantasy', icon: 'sparkles' },
  { slug: 'comedy', name: 'Comedy', icon: 'laugh' },
  { slug: 'mecha', name: 'Mecha', icon: 'robot' },
  { slug: 'sports', name: 'Sports', icon: 'trophy' },
  { slug: 'supernatural', name: 'Supernatural', icon: 'ghost' },
  { slug: 'shojo', name: 'Shojo', icon: 'ribbon' },
  { slug: 'seinen', name: 'Seinen', icon: 'moon' },
  { slug: 'movies', name: 'Anime Films', icon: 'film' },
  { slug: 'music', name: 'Music & AMV', icon: 'music' },
]

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const client = postgres(url, { max: 1 })
const db = drizzle(client)

for (const [i, category] of TAXONOMY.entries()) {
  await db
    .insert(categories)
    .values({ ...category, sortOrder: i * 10 })
    // Idempotent: re-running updates presentation but never renames a slug,
    // because the slug is the URL and the URL is the SEO asset.
    .onConflictDoUpdate({
      target: categories.slug,
      set: { name: sql`excluded.name`, icon: sql`excluded.icon`, sortOrder: i * 10 },
    })
}

const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(categories)
console.log(`Seeded taxonomy — ${row?.count ?? 0} categories.`)

await client.end()
