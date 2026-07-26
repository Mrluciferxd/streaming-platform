# Streaming Platform

Ad-supported video streaming, India-first. Built against
`streaming-platform-development-plan.md`.

**Status:** Catalogue, player, accounts and playback analytics are live at
[streaming-platform-red.vercel.app](https://streaming-platform-red.vercel.app);
the video pipeline runs from resumable upload through HLS packaging and sprites.

---

## Quick start

```bash
cp .env.example .env.local   # then fill in the secrets
createdb streaming
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

In a second terminal, for transcoding:

```bash
npm run worker
```

Health check: `http://localhost:3000/api/health` — returns 503 if Postgres is
unreachable, so an unhealthy instance leaves the load balancer rotation.

### Checks

```bash
npm test
```

Node's built-in test runner (`node:test`) over everything in `scripts/check-*`.
No test framework is installed and none is needed — the runner, the assertions
and the reporter all ship with Node.

Each file is also runnable on its own, which is how you get a useful signal
while working on one thing:

```bash
npm run check:ladder        # ladder selection        — no dependencies
npm run check:slug          # slug generation         — no dependencies
npm run check:queue         # queue concurrency       — writes to `jobs`
npm run check:rate-limit    # limiter arithmetic      — writes to `rate_limits`
npm run check:sweep         # abandoned-upload sweep  — writes to `uploads`
npm run check:analytics     # ingest → rollup         — database + running server
npm run check:token         # app ↔ edge Worker       — running server
npm run check:r2            # storage provider        — real R2 credentials
```

The ones with dependencies **skip, with the reason printed**, when the thing
they need is absent — a missing database or an unprovisioned bucket should not
look like a failure. What must never happen is a skip going unnoticed on a
machine that could have run it, so CI should set `CHECK_STRICT=1`, which turns
every unmet precondition into a failure.

The database-backed checks write and delete their own rows; point them at
development.

`check:r2` is the one to run first after provisioning the bucket. It exercises
the whole `VideoProvider` contract against real credentials — multipart
create/sign/upload/list/complete, download, directory upload, public URL,
abort, prefix delete — writing about 8 MB and removing it again.

### Smoke test

```bash
npm run smoke -- https://streaming-platform-red.vercel.app
```

Black-box, against a running deployment: public pages, sitemap and robots,
legal pages, health, the playback endpoint and its cookie, register → list →
resume position → sign out → sign back in, telemetry validation, and the
refusals on the cron, upload and admin endpoints. Exits non-zero on any failure,
so it can gate a deploy.

It registers an account and writes playback events against the deployment's
database. Both are cleaned up when `DATABASE_URL` is set locally, and named in
the output when it is not.

The transcode pipeline can be exercised end to end with no database and no cloud
credentials — plan §15.3, prove the hardest component first:

```bash
npm run transcode:local -- "" ./out && npm run verify:hls -- ./out
```

With no input file it synthesises a test clip. `verify:hls` checks the things
that are silent when broken: keyframe alignment across renditions, real bitrate
against declared `BANDWIDTH`, audio stored once, segment durations, and
decodability.

### Generating secrets

```bash
openssl rand -base64 48
```

`PLAYBACK_TOKEN_SECRET` must be identical in the app and in the Cloudflare
Worker. Verify they agree:

```bash
npm run dev
npm run check:token
```

---

## The two decisions everything else hangs off

### 1. Zero-egress delivery

Video is served from Cloudflare R2 through Cloudflare's CDN, which is free at
any egress volume. At the plan's 10k DAU scenario (~135 TB/month) this is the
difference between roughly $75/month and roughly $12,000 on CloudFront.

Cloudflare removed the old Section 2.8 restriction on serving video through the
CDN and now explicitly permits it **when the content is hosted in a Cloudflare
service** — R2 qualifies. Video served from an origin outside Cloudflare is
still restricted, so the bucket must remain the origin.

### 2. Cookie-based playback tokens

Plan §11 asks for token auth on playback URLs. The obvious implementation —
signing each segment URL per session — quietly destroys the economics above:
every viewer requests a unique URL, so nothing is shareable in the edge cache,
every segment becomes a Class B read against R2, and latency rises on every
request.

So the token lives in a **cookie**, never the query string:

- Cloudflare does not include cookies in the cache key by default, so all
  viewers share one cache entry per segment.
- The app sets the cookie on the registrable parent domain
  (`Domain=.example.com`) so browsers attach it to CDN requests automatically.
- A Worker on the CDN route verifies the signature and rejects unsigned
  requests.

**This requires the CDN hostname to be a subdomain of the app's domain**
(`example.com` + `cdn.example.com`). Decide this when you buy the domain —
retrofitting means re-cutting every URL you have published.

Implementation: [`src/lib/video/token.ts`](src/lib/video/token.ts) and
[`infra/cloudflare/playback-gate.worker.js`](infra/cloudflare/playback-gate.worker.js).
The two must agree on token format or every segment 403s;
[`scripts/check-token-interop.js`](scripts/check-token-interop.js) enforces that.

---

## Layout

```
src/
  app/                  Next.js App Router (UI + route handlers)
  db/
    schema.ts           Everything drizzle-kit manages
    schema-analytics.ts Partitioned event tables (query typing only)
    schema-ops.ts       Rate-limit counters (query typing only)
    index.ts            Pooled client + drizzle instance
  lib/
    env.ts              Zod-validated environment, fails at boot
    rate-limit.ts       Fixed-window counters in Postgres
    video/
      types.ts          VideoProvider interface + ABR ladder
      r2.ts             Cloudflare R2 implementation
      bunny.ts          Bunny Stream implementation
      token.ts          Playback token issue/verify
      probe.ts          ffprobe wrapper
      encode.ts         Ladder selection + FFmpeg args + master playlist
      sprite.ts         Poster, sprite sheet, WebVTT, hover preview
      pipeline.ts       Source file in, HLS package on disk out
      index.ts          Provider selection — the only public entry point
    jobs/queue.ts       Postgres SKIP LOCKED queue
    slug.ts             Indic-safe URL slugs
worker/                 Transcode worker (separate process)
drizzle/                Migrations (0001 and 0005 hand-written, rest generated)
infra/cloudflare/       Edge Worker
scripts/                Seed, checks (node:test), smoke test
```

### Provider swap rule

Nothing outside `src/lib/video/` may import `./r2` or `./bunny` directly, and no
provider-shaped URL is ever stored in the database — `videos.hls_master_path`
holds a bucket-relative path that the provider resolves at read time. That is
what keeps the plan §2 migration (Bunny → R2 at ~20 TB/month) a config change.
`videos.provider` is per-row, so the two can coexist during migration instead of
forcing a cutover.

---

## Database

29 tables. Departures from plan §6, all deliberate:

| Change | Why |
|---|---|
| `video_events` range-partitioned by month, 35-day retention | ~18M rows/month at 10k DAU. Pruning is `DROP TABLE`, not a `DELETE` over 200M rows. |
| `video_stats_daily`, `video_retention` rollups | What the dashboard, trending rail and `view_count` actually read. Small enough to keep forever. |
| `creators`, `revenue_shares`, `payouts` | Plan §1 makes revenue-share the content strategy; §6 had nowhere to record a split. Money is integer paise. |
| `sessions` | Server-side sessions storing only a SHA-256 of the token. |
| `audit_log` | IT Rules takedown trail — who removed what, when. |
| PK on `watch_history` | Without it every heartbeat inserts instead of upserting and Continue Watching reads garbage. |
| Unique on `video_variants (video_id, resolution)` | A re-run transcode would otherwise duplicate every rendition. |
| `videos.search_vector` generated + GIN | Postgres FTS until Meilisearch earns its keep. `simple` config, not `english` — there is no Hindi/Gujarati stemmer and English stemming makes transliterated titles worse. |
| `reports.due_at` | IT Rules gives the Grievance Officer 15 days; the overdue queue should be an index scan, not something to remember. |
| Soft deletes on `users`, `videos` | DPDP erasure without breaking referential integrity. |
| `rate_limits` | Plan §8 puts rate limiting in Redis, which is not provisioned. A per-instance limiter on serverless is decorative — see below. |

Partition maintenance runs from `/api/cron/rollup`; the equivalent by hand is:

```sql
SELECT ensure_video_events_partition((now() + interval '2 months')::date);
SELECT prune_video_events(35);
SELECT rollup_video_stats(current_date - 1);   -- nightly; idempotent
```

`rollup_video_stats` recomputes rather than accumulates, so a retried job cannot
double-count.

---

## Scheduled jobs

All three are declared in `vercel.json` and gated on `Authorization: Bearer
$CRON_SECRET`, compared in constant time — `src/app/api/cron/auth.ts` for the
two under `/api/cron`. Without that check they are public triggers for a minute
of database work each.

| Endpoint | Schedule | Does |
|---|---|---|
| `/api/cron/rollup` | daily | Rolls yesterday's events into `video_stats_daily`, syncs `videos.view_count`, creates next month's partition, drops partitions past 35 days. |
| `/api/cron/sweep` | daily | Aborts expired multipart uploads, purges expired sessions and spent rate-limit counters, requeues jobs whose worker died, drops finished job history. |
| `/api/admin/publish-due` | every 10 min | Flips scheduled titles live once `published_at` passes. Without it, scheduling a release silently does nothing. |

`publish-due` also accepts an operator session, so a scheduled release can be
forced by hand; the other two are cron-only.

**This configuration needs a Vercel Pro plan.** Hobby allows two cron jobs and
triggers them at most once a day, so three entries — one of them every ten
minutes — will not run there as written. On Hobby, drop `publish-due` to daily
and accept that a scheduled release lands up to a day late, or publish by hand.

The sweep is daily for the same reason. `uploads.expires_at` is 24 hours, so an
abandoned upload's parts live at most another day beyond that; hourly is the
right cadence once the plan allows it.

The sweep is the one that costs money if it is not running. An S3 multipart
upload whose client vanished keeps its uploaded parts, those parts bill as
storage, and **they do not appear in a bucket listing** — so the bill grows and
nothing in the console explains why. Only an abort releases them.

Every step of the sweep is independent and reports its own error, so a storage
outage cannot stop sessions being purged; the run returns HTTP 500 if any step
failed, so a monitored cron actually surfaces it.

## Rate limiting

`/api/events`, `/api/auth/login` and `/api/auth/register` are limited per IP by
a fixed-window counter in Postgres (`src/lib/rate-limit.ts`).

Plan §8 pairs this with Redis and Redis is the right answer eventually. What it
is not is a reason to ship the usual stopgap: a counter in module scope gives
every warm serverless instance its own budget, so the effective limit is
whatever was configured multiplied by however many instances are alive, and it
resets on each cold start. The cost of doing it in Postgres is one upsert per
request, which is affordable only because each of these endpoints already writes
to Postgres on the same request.

Two consequences worth knowing before tuning the numbers:

- **The budgets are loose on purpose.** Indian mobile carriers put very large
  numbers of subscribers behind one CGNAT address, so an IP here is closer to a
  neighbourhood than a person. These limits bound the damage a single abusive
  client can do; they do not meter fairly.
- **The limiter fails open.** If the counter is unavailable the database is
  unavailable, and every endpoint it protects is about to fail on its own
  anyway. A limiter that turns a database blip into a total login outage is a
  worse incident than one that is briefly absent.

---

## Video pipeline

```
POST /api/upload/create      → video row + multipart upload + signed part URLs
POST /api/upload/:id         → presign a batch of parts
GET  /api/upload/:id         → which parts landed (this is what makes resume work)
POST /api/upload/:id/complete→ finalise + enqueue transcode  (one transaction)
DELETE /api/upload/:id       → abort and release stored parts
```

Then the worker: download source → probe → ladder → HLS → poster, sprite,
preview → upload package → write `video_variants` → status `ready`.

`ready`, not `published`. Transcoding finishing is not a decision to make
something public; publishing stays an operator action (plan §7).

### Resumable upload

Plan §5.1 specifies TUS. Bunny speaks it natively, R2 does not, so the R2 path
uses S3 multipart — the client uploads parts directly to the bucket, and after a
dropped connection asks `GET /api/upload/:id` which parts already landed and
sends only the rest. R2 is the source of truth, not client-side state, so a
resume survives a browser crash or a device change.

Parts are 8 MB. That is chosen for the audience rather than for throughput: on a
connection that drops every few minutes, a failed part costs at most 8 MB of
re-upload. Bytes never transit the app server in either protocol.

### Job queue

Postgres `SELECT … FOR UPDATE SKIP LOCKED`, not the BullMQ/Redis pairing in plan
§4. Transcoding is tens to hundreds of jobs a day, each running minutes — the
opposite of the shape Redis is good at. Postgres buys three things instead:

- No second stateful service. Redis is still worth adding for the hot-query
  cache and rate limiting (plan §8); it just isn't needed to move jobs.
- **Enqueue is transactional with the video row.** `POST /complete` marks the
  upload done, moves the video to `processing`, and enqueues the job in one
  transaction. With Redis there is a window where a video says `processing` with
  no job, or a job runs against a video never marked complete.
- Jobs survive a restart without an AOF/RDB durability conversation.

Long jobs heartbeat every 30s; the reaper requeues anything stale for 120s. A
plain lock timeout cannot tell a 20-minute encode from an OOM-killed worker.
Files that will never decode are killed outright rather than burning three
multi-minute retries.

Workers are stateless — run as many as there are machines; they coordinate only
through the table.

---

## Encoding

The ABR ladder lives in [`src/lib/video/types.ts`](src/lib/video/types.ts).

One correction to the plan's reference FFmpeg command: it sets `-b:v` with no
`-maxrate`/`-bufsize`, so libx264 overshoots on complex scenes and real peak
bitrate lands well above the declared average. hls.js picks renditions by
comparing measured throughput against the playlist's `BANDWIDTH` attribute, so
an understated `BANDWIDTH` makes it choose a stream the connection cannot
sustain — surfacing as exactly the rebuffering plan §8 wants under 0.5%.

Encode capped VBR and advertise the cap:

```
-b:v:2 2800k -maxrate:v:2 3000k -bufsize:v:2 4200k
```

The ladder carries `peakBitrateKbps` per rendition for this reason, and
`video_variants.peak_bitrate_kbps` is what the master playlist is built from.

Second correction: the reference command maps `a:0` three times, duplicating
audio into every variant (~3× audio storage, and it blocks the multi-audio-track
feature in v2). One shared audio rendition group instead — which also gives the
audio-only rendition for very poor connections that plan §5.4 asks for, free.

Third: keyframes are forced onto a fixed clock (`-force_key_frames`) with
scene-cut detection off. Scene-cut keyframes land at different timestamps in
each rendition, so switching stutters — and it plays fine in a casual test.
`verify:hls` asserts boundary alignment for this reason.

Segments are 6 seconds — fewer objects, fewer Class B reads (plan §0).

### Ladder selection

Rungs are matched against the source's **shorter** side, not its height. Height
alone is right for landscape and wrong for portrait, which on a mobile-first
Indian platform is a large share of uploads. A 480×854 phone video has a height
of 854, so matching on height selects a "720p" rung and encodes 405×720 at
2800 kbps — roughly three times the bitrate those pixels need, paid on every
byte delivered. Short-side matching gives 480×854 labelled 480p at 1400 kbps:
same pixel count, same bitrate, as a landscape 854×480.

---

## Not yet built

Known gaps in what exists:

- **The R2 leg has still never run against a real bucket.** The code is
  complete and there is now a check that exercises the entire provider
  contract against real credentials — `npm run check:r2` — but nobody has
  provisioned a bucket, so the storage path remains verified by typechecking
  and nothing else. This is the first thing to run when that changes.
- **Rate limiting is per-IP and fixed-window.** Enough to bound a flood, not
  enough to be fair behind CGNAT, and a caller straddling a window boundary
  gets twice the budget briefly. Redis and a sliding window when plan §8's
  cache work happens.
- **No email verification.** `users.email_verified` never becomes true; it
  needs a transactional mail provider.
- **The sweeper runs daily, not hourly** — a cron-plan limit, not a design
  choice. See Scheduled jobs.
