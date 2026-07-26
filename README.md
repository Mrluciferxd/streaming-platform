# Streaming Platform

Ad-supported video streaming, India-first. Built against
`streaming-platform-development-plan.md`.

**Status:** Phase 1 (Foundation) — schema, storage adapter, playback-token
design, deployable shell. No video pipeline yet.

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

Health check: `http://localhost:3000/api/health` — returns 503 if Postgres is
unreachable, so an unhealthy instance leaves the load balancer rotation.

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
      index.ts          Provider selection — the only public entry point
drizzle/                Migrations (0000 generated, 0001 hand-written)
infra/cloudflare/       Edge Worker
scripts/                Seed + interop check
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
feature in v2). Use a separate audio rendition group.

Segments are 6 seconds — fewer objects, fewer Class B reads (plan §0).

---

## Not yet built

Phase 2 onward: resumable upload (S3 multipart for R2, TUS for Bunny), the
FFmpeg worker and job queue, HLS packaging, sprite generation, the player,
search, auth, admin, and ad integration.

`scripts/check-token-interop.js` is currently the only automated check. A test
runner should land before the video pipeline does.
