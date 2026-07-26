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

const TAXONOMY = [
  { slug: 'short-films', name: 'Short Films', icon: 'clapperboard' },
  { slug: 'feature-films', name: 'Feature Films', icon: 'film' },
  { slug: 'web-series', name: 'Web Series', icon: 'tv' },
  { slug: 'comedy', name: 'Comedy', icon: 'laugh' },
  { slug: 'music', name: 'Music', icon: 'music' },
  { slug: 'documentary', name: 'Documentary', icon: 'camera' },
  { slug: 'devotional', name: 'Devotional', icon: 'flame' },
  { slug: 'food-travel', name: 'Food & Travel', icon: 'utensils' },
  { slug: 'kids', name: 'Kids', icon: 'baby' },
  { slug: 'talks-interviews', name: 'Talks & Interviews', icon: 'mic' },
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
