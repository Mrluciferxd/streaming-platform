# Streaming Platform

Ad-supported video streaming, India-first. Built against
`streaming-platform-development-plan.md`.

**Status:** Phase 2 (Video pipeline) — resumable upload, transcode worker, HLS
packaging, sprites. No player or front-end yet.

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
npm run check
```

Ladder selection, slug generation, and queue concurrency. The queue checks need
a database and write to `jobs`, so point them at development.

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
    index.ts            Pooled client + drizzle instance
  lib/
    env.ts              Zod-validated environment, fails at boot
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
drizzle/                Migrations (0000/0002 generated, 0001 hand-written)
infra/cloudflare/       Edge Worker
scripts/                Seed + checks
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

Partition maintenance — wire to a monthly cron:

```sql
SELECT ensure_video_events_partition((now() + interval '2 months')::date);
SELECT prune_video_events(35);
SELECT rollup_video_stats(current_date - 1);   -- nightly; idempotent
```

`rollup_video_stats` recomputes rather than accumulates, so a retried job cannot
double-count.

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

Phase 3 onward: the player, homepage and browse, search, auth, admin panel, and
ad integration.

Known gaps in what exists:

- **The R2 leg is unverified.** Everything up to and including HLS packaging is
  tested locally, but `downloadToFile`/`uploadDirectory`/multipart have never run
  against a real bucket. That needs credentials.
- **Upload auth is a shared bearer token** (`UPLOAD_ADMIN_TOKEN`), not sessions.
  It cannot be revoked per person and gives no attribution for
  `videos.uploader_id`. Replace when Phase 3 auth lands —
  `src/lib/auth/upload-guard.ts`.
- **No abandoned-upload sweeper.** `uploads.expires_at` is set but nothing acts
  on it, so a client that vanishes mid-upload leaves multipart parts billing as
  storage until someone aborts them.
- Checks are standalone scripts under `scripts/`. A real test runner should land
  before the surface grows much further.
