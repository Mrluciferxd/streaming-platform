import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { env, isProd } from '@/lib/env'
import * as analytics from './schema-analytics'
import * as schema from './schema'

/**
 * A single pooled client per process. In dev the Next.js hot reloader
 * re-evaluates modules on every edit, so the client is stashed on globalThis —
 * otherwise each save leaks a pool and Postgres runs out of connections within
 * a few minutes.
 */
const globalForDb = globalThis as unknown as {
  __sql?: ReturnType<typeof postgres>
}

const client =
  globalForDb.__sql ??
  postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    // Set DATABASE_PREPARE=false when connecting through PgBouncer in
    // transaction mode (plan §8) — it cannot carry prepared statements across
    // pooled connections and every query will fail with "prepared statement
    // does not exist".
    prepare: env.DATABASE_PREPARE,
    idle_timeout: 20,
    connect_timeout: 10,
  })

if (!isProd) globalForDb.__sql = client

export const db = drizzle(client, { schema: { ...schema, ...analytics } })
export { client as sqlClient }
export * from './schema'
export * from './schema-analytics'
