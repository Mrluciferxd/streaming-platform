# Database

## What this subsystem does

All persistent state: catalogue, accounts, sessions, jobs, uploads, telemetry,
audit trail, rate-limit counters.

## How it is structured

Postgres 17 on Neon, accessed through Drizzle. Three schema files, deliberately
split by who owns the DDL:

| File                     | Managed by      | Why                                   |
|--------------------------|-----------------|---------------------------------------|
| `src/db/schema.ts`       | drizzle-kit     | Ordinary tables                       |
| `src/db/schema-analytics.ts` | hand-written SQL | `PARTITION BY` is inexpressible in drizzle-kit |
| `src/db/schema-ops.ts`   | hand-written SQL | Rate-limit counters                   |

Migrations in `drizzle/`. `0000`, `0002`, `0003`, `0004`, `0006` are generated;
`0001` and `0005` are hand-written and chained into `meta/_journal.json`
manually.

32 tables. The ones with non-obvious design:

- `videos` — soft-deleted, generated `search_vector`, denormalised `view_count`,
  `provider` per row so a storage migration can be incremental.
- `video_events` — range-partitioned by month, no FK, 35-day retention.
- `jobs` — `SKIP LOCKED` queue with heartbeat, backoff, dead-letter.
- `audit_log` — append-only, the IT Rules takedown trail.
- `creators` / `revenue_shares` / `payouts` — money as integer paise.

## Conventions and rules

- **Money is `bigint` paise.** Never float, never decimal-as-text.
- **Cursor pagination, never `OFFSET`.** `OFFSET 10000` makes Postgres scan and
  discard 10,000 rows on every infinite-scroll request.
- Cursors carry an id tiebreaker: `published_at` is not unique, and a bulk
  import gives many rows the same timestamp, so without it rows repeat or vanish
  across page boundaries.
- Read queries live in `src/lib/queries/`, never inline in a page or handler.
- Migrations do **not** run on deploy. Run `npm run db:migrate` yourself.

## Known gotchas

**Untyped Drizzle parameters take their type from a sibling.** In
`coalesce(${column}, ${value})` the parameter resolves to the column's type, and
a later fraction then arrives as an integer literal. This produced a production
500 (ISSUE-002). Cast explicitly: `${value}::numeric`.

**Drizzle wraps driver errors.** Its own `message` is the SQL text, so matching
a constraint name in the message never fires. The real `PostgresError` with
SQLSTATE 23505 is on `cause` — `isUniqueViolation()` walks the chain.

**`db.execute` bypasses Drizzle's bigint mapping.** postgres.js returns int8 as
a *string* to avoid precision loss, so a raw query returns `"18"` where the
typed API returns `18`. Coerce at the boundary; typing it as `number` compiles
and lies.

**`now()` cannot live in an index predicate** — it is not immutable. The
`publiclyVisible` predicate uses `videos_published_idx` for the status and
deleted checks and filters the timestamp on what the index returns.

**`DATABASE_PREPARE=false` when going through the pooler.** PgBouncer in
transaction mode cannot carry prepared statements across pooled connections and
every query fails with "prepared statement does not exist".

**`search_vector` uses the `simple` configuration.** There is no Hindi or
Gujarati stemmer, and English stemming makes transliterated titles worse.

**Generated identity columns must be declared generated in Drizzle too**, or it
includes them in inserts and Postgres rejects the statement.

## How it is tested

Indirectly by every integration check — `check-queue`, `check-rate-limit`,
`check-sweep`, `check-history` all run against real Neon, create timestamped
rows and clean up in `after()`. There is no migration test; the schema is
verified by the queries that use it.

## Related

- [analytics.md](analytics.md) — partitioning and rollups
- [architecture.md](architecture.md) — where the database sits
