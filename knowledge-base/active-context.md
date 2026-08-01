## Current Status

**Last Updated**: 2026-08-01
**Last Agent Session**: Built the series/episodes admin surface (the largest gap
left in the operator panel — anime is episodic, but until now series rows had
to be created by direct SQL). New routes: `/admin/series`, `/admin/series/[id]`,
`/api/admin/series/*`. Existing `VideoEditor` gained a "Series placement"
panel. Then closed the testing gap: wrote `scripts/check-series-admin.ts` (a
live-Postgres integration check that exercises the full CRUD path and the
`listEpisodeCandidates` picker), wired it as `check:series-admin`, and added a
`.github/workflows/ci.yml` running `tsc --noEmit` + `npm test` on Node 22
(without `CHECK_STRICT` — DB-dependent checks skip via `unmet()` until a
`DATABASE_URL` repo secret is provisioned). The check caught a SQLSTATE 42702 in `listEpisodeCandidates`
(Drizzle drops the `from()` alias inside select-map `sql\`\`` snippets), which
is now fixed via `alias(videos, 'v')` + hardcoded `"v"."id"` in the two scalar
subqueries. The placeholder-media next-step (below) is also finished, on
commit `2b3c4ec` — recorded retroactively.

**Test Suite Status**: 87 pass, 0 fail (`npm test`). Smoke 37/37 against
production. The new `check-series-admin` contributes 10 assertions against a
live Postgres. Two suites still skip without infrastructure: `check-r2` (no
credentials), `check-analytics`/`check-token` (no local server). In CI (see
`.github/workflows/ci.yml`), the suite runs WITHOUT `CHECK_STRICT`, so all
DB-dependent checks skip via `unmet()` until a `DATABASE_URL` repo secret is
provisioned — flipping CI to `CHECK_STRICT=1` is the next CI action item once
that secret exists. `npm run typecheck` clean. `npm run lint` is broken on this
Next 16 install — no ESLint config — and is a pre-existing condition, not part
of this work.

**Deployed**: https://streaming-platform-red.vercel.app — last deployed commit
`0e5de8e`. **The new admin surface is committed but not yet deployed.**

## In Progress

Series/episodes admin is feature-complete, typechecks, and the suite is green,
but **not yet run against a browser**. The episode-list UI, the add-episode
picker, the reorder-arrow interaction, and the cross-page "attach from the
video editor" flow have all been reasoned about but not exercised. Manual
verification is the next step before deploying.

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

1. Provision R2 and run `npm run check:r2`. This closes the largest verification
   gap and lets the demo stop serving media through the platform.
2. **Manually exercise the series/episodes admin in the browser** before
   deploying. The flows to walk: create a series from `/admin/series`, attach
   two existing videos as S1·E1 and S1·E2 from the series detail page, reorder
   them, detach one, then go to a video's edit page and attach it to a series
   via the new "Series placement" panel. Verify the public `/series/<slug>`
   page reflects the changes.
3. ~~Add an admin-side integration check — `scripts/check-series-admin.ts`~~
   **Done** this session. Wired as `check:series-admin`; 10 assertions against a
   live Postgres; full suite now 87 pass.
4. Add a browser test harness. The player is the biggest untested surface —
   see [player.md](player.md).
5. ~~Set up CI~~ **Done** this session. `.github/workflows/ci.yml` runs
   `npm ci`, `tsc --noEmit`, `npm test` on Node 22 (without `CHECK_STRICT`, so
   DB-dependent checks skip via `unmet()` today). Next CI step: provision a
   `DATABASE_URL` repo secret and flip the test step to
   `npm test --CHECK_STRICT=1`.
6. ~~Replace the seeded FFmpeg test patterns with real key art.~~ **Done** in
   commit `2b3c4ec` (generated key visuals + Ken Burns footage, verified
   against a production build). Left struck through so the prior plan is
   traceable.
7. Comments and ratings (plan §7 v2) — tables exist, unused.
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
