# Changelog

Newest first.

## 2026-08-02 — Account dashboard page (/me)
**What**: New `/me` route — a single signed-in-viewer hub showing the profile
header (avatar initial, display name, masked email, "member since"), a
Continue Watching rail, a My List grid with a "See all" link to `/my-list`,
and a Recently Watched list (with progress % or "Finished" and a date per
row). The header now shows an "Account" link for signed-in users, and the
avatar circle links to `/me` instead of silently signing the viewer out —
sign-out is now an explicit button on `/me`.
**Why**: A signed-in viewer had nowhere to land. `/account` is the sign-in form
and redirects signed-in users to `/`; the only viewer surface was `/my-list`.
There was no hub for "my own data" — continue watching, my list, history,
sign-out — even though every underlying read existed. The dashboard composes
those reads into one page with no new tables and no new API routes.
**Impact**: A viewer signing in lands on a single page that surfaces everything
about their account. Sign-out is no longer a surprise avatar click (it dropped
your session with no confirmation); it's a labelled button on `/me`. The
header avatar now navigates instead of destroying state.
**Files Changed**:
- New: `src/app/me/page.tsx` (the dashboard; `force-dynamic`, `robots noindex`,
  redirect to `/account?next=%2Fme` when not signed in — matching the `/my-list`
  convention)
- New: `src/app/me/SignOutButton.tsx` (client button; DELETEs the session and
  hard-navigates to `/` so no stale server-component tree remains)
- Modified: `src/lib/queries/history.ts` (new `listRecentHistory` — recently
  watched including finished titles; `listContinueWatching` deliberately hides
  completed rows so the resume rail stays uncluttered, but the dashboard wants
  the full recency stream)
- Modified: `src/components/HeaderShell.tsx` (added "Account" link next to
  "My List" for signed-in users; avatar now links to `/me` instead of signing
  out on click)
**Tests**: `npm test` 103 pass, 0 fail. `npx tsc --noEmit` clean. Verified
via curl: `/me` with a session returns 200 and renders all four sections plus
the profile; without a session it 307-redirects to `/account?next=%2Fme`.
`maskEmail` reveals only the first character of the local part so the full
address does not sit in an HTML response.
**Commit**: pending

## 2026-08-01 — Fix reorder tripping episodes_series_season_ep_key
**What**: The `POST /api/admin/series/[id]/reorder` endpoint returned 500 on
cyclic slot swaps (e.g. swap E1↔E99). `reorderEpisodes` updated rows one at a
time, so writing E99 onto the `(1,1)` slot collided with E1's row before E1
had been moved off — `episodes_series_season_ep_key` fired mid-loop. The route
also wasn't wrapping the rewrite in a transaction.
**Why**: Discovered by manual API verification during the session that shipped
the series admin surface. The categories reorder sidesteps this because
`categories.sort_order` is a plain integer with no unique constraint; episodes
carry a real unique key on `(series_id, season_no, episode_no)`, so a naive
sequential rewrite is unsafe for any reorder that moves a row onto a slot
another row still occupies. Covers the case `check-series-admin` does not
(the check exercises attach/detach/update but not a full reorder with cycles).
**Impact**: Reorder now succeeds for arbitrary renumbering. Two fix pieces:
(a) `reorderEpisodes` does a two-phase update within the caller's transaction —
phase 1 parks every row on a throwaway `episode_no` in a high band
(`30000 + i`, safely above the zod-capped 9999 and below the smallint ceiling
of 32767, distinct per row by index, and still `> 0` to satisfy the column
CHECK), phase 2 writes the final slots once the colliding slots are empty.
(b) The route now wraps both phases + the audit row in a single
`db.transaction`, and pre-rejects a request whose new order contains duplicate
`(season, episode)` pairs as 409 `slot_taken` (matching the single-update
attach path) instead of letting it surface as a 500 from phase 2.
**Files Changed**:
- Modified: `src/lib/queries/admin.ts` (`reorderEpisodes` two-phase)
- Modified: `src/app/api/admin/series/[id]/reorder/route.ts` (tx wrap +
  duplicate-slot pre-check)
**Tests**: `npm test` 103 pass, 0 fail (the local server being up enabled the
analytics + token suites, which skip otherwise; DB-dependent checks all pass).
`npx tsc --noEmit` clean. Re-verified end-to-end via the API: cyclic
E1↔E99 reorder now returns 200 and the episode list reflects the new order; a
reorder request with two rows targeting the same slot returns 409
`slot_taken` with a human-readable `detail`.
**Commit**: pending

## 2026-07-31 — Series & episodes admin surface
**What**: New `/admin/series` list + new-series form, `/admin/series/[id]` editor
with ordered episode list and add-episode picker, and a "Series placement"
panel inside the existing `VideoEditor`. New API: `GET/POST /api/admin/series`,
`GET/PATCH/DELETE /api/admin/series/[id]`, `GET/POST /api/admin/series/[id]/episodes`,
`POST /api/admin/series/[id]/reorder`. Six new audit actions:
`series.{create,update,delete}` and `episode.{attach,update,detach}`.
**Why**: Anime is episodic and the series — not the episode — is what a viewer
searches for (see the `series` schema block). Until now every series and
episode row had to be created by direct SQL, because the admin panel did not
surface the join. That left the platform's central use case writable only by a
person with a database connection. This was the single largest gap in the
operator surface.
**Impact**: Operators can now create a series, attach existing library videos
as episodes, reorder them in broadcast order, edit per-episode titles, and
detach — all without leaving the panel. The unique `episodes_video_key` index
("a video belongs to at most one series") is enforced at the API layer as
409 `already_attached`, not a 500. Compare-and-swap on the unique
`episodes_series_season_ep_key` is enforced as 409 `slot_taken`. Both
explanations include a `detail` field. Every change writes to `audit_log` with
the actor, IP, and a before/after diff.
**Files Changed**:
- New: `src/app/admin/series/page.tsx`, `src/app/admin/series/SeriesManager.tsx`,
  `src/app/admin/series/[id]/page.tsx`, `src/app/admin/series/[id]/SeriesEditor.tsx`
- New: `src/app/api/admin/series/route.ts`, `[id]/route.ts`,
  `[id]/episodes/route.ts`, `[id]/reorder/route.ts`
- New: `scripts/check-series-admin.ts` (integration check: create/list/attach/
  detach/update/reorder/audit + the `listEpisodeCandidates` picker, with fixture
  isolation and `after()` cleanup), wired as `check:series-admin` in `package.json`
- New: `.github/workflows/ci.yml` (Node 22; `npm ci`, `tsc --noEmit`,
  `npm test`; runs without `CHECK_STRICT` so DB-dependent checks skip via
  `unmet()` when `DATABASE_URL` is absent — switch to `CHECK_STRICT=1` once a
  `DATABASE_URL` repo secret is provisioned)
- Modified: `src/app/admin/AdminNav.tsx` (added the Series tab)
- Modified: `src/app/admin/videos/[id]/page.tsx` (now also fetches the episode
  link + the candidate series list)
- Modified: `src/app/admin/videos/[id]/VideoEditor.tsx` (new "Series placement"
  panel; the editor's prop surface grew by `seriesLink` and `allSeries`)
- Modified: `src/lib/queries/admin.ts` (new series/episodes section: ~280
  lines; the `AuditAction` union extended; `recordAudit`'s `entityType`
  widened to allow `'series'` and `'episode'`; `listEpisodeCandidates` uses
  `alias(videos, 'v')` from `drizzle-orm/pg-core` — see the fix note below)
**Tests**: `npm test` 87 pass, 0 fail. `npx tsc --noEmit` clean. The new
`check-series-admin` script covers the full series/episode CRUD path against a
live Postgres and exercises the SQLSTATE 42702 regression in
`listEpisodeCandidates` (see fix note below).
**Fix note (SQLSTATE 42702 in `listEpisodeCandidates`)**: The query has two
scalar subqueries in the select map that reference the outer `videos` row, plus
a `NOT EXISTS` in the where clause. Drizzle's `sql\`\`` template interpolates
`${v.id}` as the bare `"id"` column name inside select-map snippets (it does not
carry the `from(v)` alias there), which is ambiguous against `episodes.id` and
trips 42702. The where-clause interpolation, by contrast, does emit the
qualified `"v"."id"`. We keep `${v.id}` in the NOT EXISTS (it works) but hardcode
`"v"."id"` in the two select subqueries where Drizzle drops the qualifier.
Discovered by check-series-admin; never reached by typecheck (42702 surfaces
only when the query actually runs against Postgres).
**Commit**: pending

## 2026-07-27 — Demo catalogue: generated key visuals and footage
**What**: Replaced the FFmpeg colour-bar placeholder media with generated key
visuals (satori, inside `next/og`, no new dependency) and Ken Burns footage over
each title's own landscape backdrop. 17 videos across 12 titles, two of them
proper multi-episode series with real episode titles.
**Why**: The UI could not be judged against colour bars, and the 2:3 card
layout in particular was built for artwork that did not exist. This was
previously listed as a "next step" in `active-context.md` and is now done —
this entry records it retroactively because it had not been logged.
**Impact**: The catalogue renders with real art. Clips run through the real
pipeline (probe, ladder, HLS, sprite). Media size capped at 480p source on
purpose: the no-upscale rule keeps the ladder at three rungs, which keeps the
shipped demo bundle small.
**Files Changed**: seed scripts, `public/` assets, seeded catalogue rows.
**Tests**: Verified against a production build: video mounts and plays, 854×480,
segments and sprite VTT fetched, episode list marks the current episode.
**Commit**: `2b3c4ec`

## 2026-07-27 — Knowledge base created
**What**: Added `knowledge-base/` per the global agent rules.
**Why**: Required for change tasks; the project had accumulated substantial
non-obvious design (cookie-based playback auth, short-side ladder matching,
Postgres queue) documented only in code comments and commit messages.
**Impact**: Documentation only.
**Files Changed**: `knowledge-base/*` (13 files)
**Tests**: None applicable — documentation. Full suite re-run after: 77 pass.
**Commit**: pending (now `7c20a74`)

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
