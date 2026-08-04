## Current Status

**Last Updated**: 2026-08-04
**Last Agent Session**: (1) Shipped the series/episodes admin surface +
`check-series-admin.ts` + CI workflow (commit `2dade27`). (2) Manual API
verification caught and fixed a 500 in `POST /api/admin/series/[id]/reorder`
— `reorderEpisodes` tripped `episodes_series_season_ep_key` mid-loop; rewrote
it as a two-phase update inside a transaction and added a duplicate-slot
pre-check returning 409 `slot_taken` (commit `8107550`). (3) Built the
account dashboard at `/me`: profile header, Continue Watching, My List,
Recently Watched, with an explicit Sign-out button and header link changes
(commit `9a9a84c`). (4) Ratings/reactions UI shipped (commit `6b9ab34`).
(5) Fixed a high-severity deploy bug: demo media 404'd on production because
`.vercelignore`'s lone `!public/media` did not re-include gitignored
children; added `!public/media/` + `!public/media/**` (commit `7c2030c`,
ISSUE-008). Net new viewer surface: `/me`. Net new operator surface: the
whole series/episodes admin.

**Test Suite Status**: 103 pass, 0 fail (`npm test`) with the dev server up
(the analytics + token suites need a live `localhost:3000`; without it the
suite is 87 pass / 0 fail). `npx tsc --noEmit` clean. The new
`check-series-admin` exercises the full series/episode CRUD path against a
live Postgres. In CI (`.github/workflows/ci.yml`), the suite runs WITHOUT
`CHECK_STRICT`, so DB-dependent checks skip via `unmet()` until a
`DATABASE_URL` repo secret is provisioned; flipping to `CHECK_STRICT=1` is the
next CI action item once that secret exists. `npm run lint` is broken on this
Next 16 install — no ESLint config — and is a pre-existing condition.

**Deployed**: https://streaming-platform-red.vercel.app — last deployed commit
`7c2030c` (media fix, this session). All commits through `7c2030c` are live.
The ratings commit `6b9ab34` was pushed and CI-green but NOT deployed as a
standalone; it is included in the `7c2030c` deploy (CLI deploys upload the
working tree, and `6b9ab34` was already on `main`). Smoke suite 37/37 green
against the production deployment. `VIDEO_PROVIDER=local` +
`ALLOW_LOCAL_MEDIA=1` are set in production env; media now serves (85MB of
demo media ships with the deploy — see ISSUE-008 for the `.vercelignore`
mechanics that broke and the fix).

## In Progress

## In Progress

The comments build (Build 2 of 4) is committed this session: `/api/comments`
(GET thread / POST top-level or reply) + `Comments` client component on the
watch page. E2E-verified (15 cases incl. the `inArray` fix for the 22P02
malformed-array-literal regression). Service surface complete; remaining
build items are Build 3 (reports queue) and Build 4 (admin user management).
The series admin API surface is verified end-to-end and the React rendering
was given a visual browser pass before deploy; the account dashboard was
curl-verified and visually checked.

## Blocked On

- **R2 provisioning** — the entire storage path is unverified (ISSUE-001). The
  deployment runs `VIDEO_PROVIDER=local`, which is a demo configuration: media
  ships with the deployment and is billed at platform bandwidth rates, the exact
  cost profile the architecture exists to avoid. Needs a Cloudflare account, a
  bucket, a custom domain that is a **subdomain of the app domain**, and a CORS
  rule allowing PUT. Then `npm run check:r2`.
- **Ad network** — the VAST path cannot be verified without a GAM account and a
  live tag (ISSUE-007).
- **Content rights** — anime is almost entirely licensed. AdSense and GAM ban
  sites hosting content the operator has no rights to, so this determines
  whether the ad model works at all. Not a technical blocker; it is *the*
  business blocker.

## Decisions Needed

- **Vercel plan.** Hobby caps crons at two, daily. That is currently survivable
  — scheduled publishing was redesigned to need no cron — but any future job
  needing finer granularity forces an upgrade.
- **Creator self-serve upload.** Upload is admin/moderator only. Opening it to
  creators needs quotas, ownership and moderation decided first.
- **Redis.** Not provisioned. Wanted for the hot-query cache (the home page is
  per-request now) and would be the better home for rate limiting.

## Next Steps

1. Provision R2 and run `npm run check:r2`. This closes the largest
   verification gap and lets the demo stop serving media through the
   platform.
2. Add a `DATABASE_URL` repo secret and flip CI to `npm test --CHECK_STRICT=1`.
   Today CI skips every DB-dependent check via `unmet()`; that is the gate to
   the suite actually running in CI rather than skipping.
3. Add a browser test harness. The player is the biggest untested surface —
   see [player.md](player.md).
4. ~~Set up CI~~ **Done**. `.github/workflows/ci.yml` runs
   `npm ci`, `tsc --noEmit`, `npm test` on Node 22 (without `CHECK_STRICT`).
5. ~~Add an admin-side integration check — `scripts/check-series-admin.ts`~~
   **Done**. Wired as `check:series-admin`; suite now 103 pass with the dev
   server up.
6. ~~Replace the seeded FFmpeg test patterns with real key art.~~ **Done** in
   commit `2b3c4ec` (generated key visuals + Ken Burns footage, verified
   against a production build). Left struck through so the prior plan is
   traceable.
7. Comments and ratings (plan §7 v2) — tables exist, unused. User declined
   comments UI + ratings UI this session in favour of the account dashboard.
8. **Other admin gaps** that remain after this session (see `admin.md`):
   IT-Rules grievance/reports queue (`reports` table is scaffolding with no
   UI), user/account management, comment moderation, creator & payouts
   surface, per-video analytics drill-down.

## Do Not Touch

- **`src/lib/video/token.ts` and `infra/cloudflare/playback-gate.worker.js`** —
  read the comment at the top of `token.ts` first. Moving the token into a query
  string is the single most expensive mistake available here.
- **`drizzle/0001_analytics.sql` and `drizzle/0005_rate_limit.sql`** —
  hand-written, chained into `meta/_journal.json` manually. Do not regenerate.
- **Two test accounts** (`admin-test@localhost.test`,
  `viewer-test@localhost.test`) — deleting them nulls the actor on audit rows
  they generated.
