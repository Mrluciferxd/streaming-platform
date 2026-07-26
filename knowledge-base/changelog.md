# Changelog

Newest first.

## 2026-07-27 — Knowledge base created
**What**: Added `knowledge-base/` per the global agent rules.
**Why**: Required for change tasks; the project had accumulated substantial
non-obvious design (cookie-based playback auth, short-side ladder matching,
Postgres queue) documented only in code comments and commit messages.
**Impact**: Documentation only.
**Files Changed**: `knowledge-base/*` (13 files)
**Tests**: None applicable — documentation. Full suite re-run after: 77 pass.
**Commit**: pending

## 2026-07-27 — Fix a 500 in Continue Watching, and cover the endpoint
**What**: Cast Drizzle parameters explicitly in the resume-band query; moved the
query to `src/lib/queries/history.ts`; added `scripts/check-history.ts`.
**Why**: `GET /api/history` answered 500 for every signed-in viewer. Drizzle
sends untyped parameters, so `coalesce(duration_sec, $n)` resolved $n to integer
and the 0.05 fraction was then parsed as an integer.
**Impact**: Continue Watching works. The endpoint is now covered — it reached
production through typecheck, build and 69 green tests because nothing executed
that SQL.
**Files Changed**: `src/lib/queries/history.ts` (new),
`src/app/api/history/route.ts`, `scripts/check-history.ts` (new), `package.json`
**Tests**: 8 new; suite 69 → 77, all passing. Smoke 37/37 against production.
**Commit**: `0e5de8e`

## 2026-07-27 — Continue Watching floor proportional to runtime
**What**: Resume floor is now `least(15s, 5% of runtime)` on both server and
client.
**Why**: A flat 15s floor left an empty band for anything shorter than ~16s —
every qualifying position was at or past the end, so short titles could never
appear. Music and AMV are top-level categories here.
**Impact**: Short content can be resumed. Long content unchanged.
**Files Changed**: `src/app/api/history/route.ts`, `src/lib/player/resume.ts`,
`scripts/smoke.ts`
**Tests**: Smoke suite; 3 previously failing assertions traced to this.
**Commit**: `02aa4c2`

## 2026-07-27 — Publish clock in the read path, not a cron
**What**: `publiclyVisible` predicate in `src/lib/queries/visibility.ts`, used in
nine places. Scheduling publishes with a future `published_at`.
**Why**: The deploy was rejected — the account's plan allows only daily crons,
and scheduling had a 10-minute sweep. Lowering it to daily would have meant a
9am release going live at midnight.
**Impact**: A schedule can no longer silently fail. Crons back to two daily.
**Files Changed**: `src/lib/queries/visibility.ts` (new), `videos.ts`,
`series.ts`, `sitemap.ts`, `my-list`, `watchlist`, `history`, `playback`,
`watch/[slug]`, admin status route, `vercel.json`
**Tests**: 69 pass. Verified a live title parked two days out disappears and
returns.
**Commit**: `ed5001e`

## 2026-07-27 — Series and episodes, ads, rate limiting, sweeper, test suite
**What**: Four parallel workstreams merged.
**Why**: Anime is episodic and every title was standalone; there was no
monetisation; three public endpoints were unlimited; `uploads.expires_at` was
set but unacted on; verification was hand-rolled scripts.
**Impact**: Large. New tables, new CSP entries, new crons.
**Files Changed**: ~40 across `src/app/series`, `src/lib/ads`, `src/lib/queries`,
`src/db`, `scripts`, `drizzle/0005`, `drizzle/0006`
**Tests**: 69 pass. Smoke 31/37 at the time (6 failures were deployment lag).
**Commit**: `9c856ee`

## 2026-07-26 — Admin panel
**What**: Operator surface with upload, library, metadata, publishing,
categories, analytics, dead-letter queue, audit trail. Upload auth moved from a
shared bearer token to session roles.
**Why**: Content was only addable by running a script.
**Impact**: `UPLOAD_ADMIN_TOKEN` removed. Upload attribution now works.
**Files Changed**: `src/app/admin/**`, `src/app/api/admin/**`,
`src/lib/auth/require-role.ts`, `src/lib/queries/admin.ts`, upload routes
**Tests**: Manual against the live database; role matrix, status lifecycle,
category CRUD, analytics, dead-letter retry.
**Commit**: `fa6f5cb`

## 2026-07-26 — Analytics, auth, watchlist, legal pages, SEO
**What**: Telemetry wired end to end; accounts and sessions; My List and
server-side Continue Watching; legal pages; sitemap and robots.
**Why**: The rollup infrastructure existed with nothing feeding it — trending
fell back to "newest" and view counts were seeded random numbers. Four footer
links 404'd, including the Grievance Officer page the IT Rules require.
**Impact**: Home page moved from ISR to per-request.
**Files Changed**: ~20
**Tests**: 21 production checks passed.
**Commit**: `b78c866`

## 2026-07-26 — Anime catalogue redesign
**What**: Light rounded theme, portrait key visuals, sub/dub, genre taxonomy,
`portrait_url` / `has_sub` / `has_dub` / `season_label` / `score`.
**Why**: Product pivoted to anime; requested look was light and cartoon-styled.
**Impact**: Every colour and font utility rewritten — Tailwind v4 dropped the v3
`bg-[--color-x]` form and fails silently.
**Files Changed**: ~15, `drizzle/0004`
**Tests**: Verified in browser.
**Commit**: `e56c08d`

## 2026-07-26 — Earlier phases
`54da2c6` catalogue UI · `d1d7c23` player, discovery, first deploy ·
`bc840d9` video pipeline · `42cb892` foundation, schema, storage adapter
