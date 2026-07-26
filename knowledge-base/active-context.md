## Current Status

**Last Updated**: 2026-07-27
**Last Agent Session**: Merged four parallel workstreams (series/episodes, ads,
admin panel, ops hardening), fixed a production 500 in Continue Watching,
replaced the scheduled-publish cron with a read-path predicate, and created this
knowledge base.
**Test Suite Status**: 77 pass, 0 fail (`npm test`). Smoke 37/37 against
production. Two suites skip without infrastructure: `check-r2` (no credentials),
`check-analytics`/`check-token` (no local server).

**Deployed**: https://streaming-platform-red.vercel.app — commit `0e5de8e`.

## In Progress

Nothing mid-flight. Everything committed and deployed.

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
2. Add a browser test harness. The player is the biggest untested surface —
   see [player.md](player.md).
3. Set up CI. There is none; deploys are manual and nothing runs the suite
   automatically. `CHECK_STRICT=1` exists for exactly this.
4. Replace the seeded FFmpeg test patterns with real key art. The 2:3 card
   layout cannot be judged against colour bars.
5. Comments and ratings (plan §7 v2) — tables exist, unused.

## Do Not Touch

- **`src/lib/video/token.ts` and `infra/cloudflare/playback-gate.worker.js`** —
  read the comment at the top of `token.ts` first. Moving the token into a query
  string is the single most expensive mistake available here.
- **`drizzle/0001_analytics.sql` and `drizzle/0005_rate_limit.sql`** —
  hand-written, chained into `meta/_journal.json` manually. Do not regenerate.
- **Two test accounts** (`admin-test@localhost.test`,
  `viewer-test@localhost.test`) — deleting them nulls the actor on audit rows
  they generated.
