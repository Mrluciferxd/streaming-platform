import { defineConfig } from 'drizzle-kit'

/**
 * `schema` deliberately points only at schema.ts.
 *
 * schema-analytics.ts is excluded because `video_events` is range-partitioned,
 * which drizzle-kit cannot express — including it would make drizzle-kit
 * generate a plain CREATE TABLE and then try to "fix" the partitioned one on
 * every subsequent generate. Its DDL lives in drizzle/0001_analytics.sql.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
})
