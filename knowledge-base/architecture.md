# Architecture

## System Overview

An ad-funded anime catalogue. Viewers browse rows of portrait key visuals and
play HLS streams; operators upload sources through an admin panel; a separate
worker transcodes them into an adaptive bitrate ladder and pushes the package to
object storage, from which a CDN serves it directly to browsers.

The single organising constraint is delivery cost. Video is ~1 GB per viewing
hour, and at the plan's growth scenario (10k DAU) that is ~135 TB/month. On
per-GB CDN pricing the bandwidth bill exceeds ad revenue several times over, so
every architectural decision that touches bytes is subordinate to keeping
delivery near zero marginal cost.

## Architecture Diagram

```
                    ┌───────────────────────────┐
                    │  Browser (Next.js + hls)  │
                    └──────┬─────────────┬──────┘
              JSON + cookie│             │ media (never via the app)
                    ┌──────▼──────┐   ┌──▼──────────────────┐
                    │  Next.js    │   │  CDN edge           │
                    │  App Router │   │  + playback-gate    │
                    │  = the API  │   │    Worker           │
                    └──────┬──────┘   └──┬──────────────────┘
                           │             │ origin
              ┌────────────▼───┐      ┌──▼────────────┐
              │  Postgres      │      │  R2 bucket    │
              │  (Neon)        │      │  HLS package  │
              │  metadata      │      └──▲────────────┘
              │  jobs queue    │         │ upload
              │  events (part.)│      ┌──┴────────────┐
              └────────▲───────┘      │  Transcode    │
                       │  claim/report│  worker       │
                       └──────────────┤  FFmpeg       │
                                      └───────────────┘
```

The application server never touches video bytes. It serves JSON metadata and
mints a playback cookie; media flows browser ← CDN ← bucket. That is what lets a
small server support a large audience.

## Layers & Responsibilities

| Layer        | Technology                | Responsibility                                       |
|--------------|---------------------------|------------------------------------------------------|
| Frontend     | Next.js App Router, React | Catalogue UI, player, admin panel                    |
| Backend/API  | Next.js route handlers    | Auth, playback tokens, uploads, telemetry, admin API |
| Database     | Postgres 17 (Neon)        | Metadata, sessions, jobs, partitioned events         |
| Auth         | scrypt + server sessions  | Accounts, roles, the admin gate                      |
| Queue/Jobs   | Postgres SKIP LOCKED      | Transcode jobs, retries, dead letters                |
| Storage      | R2 / Bunny / local        | Source files and HLS packages, behind one interface  |
| CDN          | Cloudflare + Worker       | Segment delivery, playback-cookie enforcement        |
| Worker       | Node + FFmpeg             | Probe, ladder, HLS packaging, sprites                |
| Testing      | `node:test`               | 77 tests plus a black-box smoke suite                |

## Data Flow

**Upload → published.** Admin requests a resumable upload → server creates the
`videos` row and an S3 multipart upload → browser PUTs parts directly to the
bucket with presigned URLs → `complete` finalises the upload, moves the video to
`processing` and enqueues a transcode job *in one transaction* → worker claims
the job, downloads the source, probes it, encodes the ladder, uploads the
package, writes `video_variants`, sets `ready` → an operator publishes.

**Playback.** Watch page renders shell and metadata (cacheable) → client calls
`/api/playback/[slug]` → server checks visibility, issues an anonymous session
id and an HMAC playback cookie scoped to the media path → hls.js loads the
master playlist from the CDN → the edge Worker verifies the cookie and serves
segments, cache key = URL only.

**Telemetry.** Player buffers events and flushes every 15s (`sendBeacon` on
unload) → `/api/events` validates and inserts into the monthly partition → the
nightly cron rolls yesterday into `video_stats_daily` and syncs
`videos.view_count` → trending and the admin dashboard read the rollup, never
the raw events.

## Key Design Patterns

- **Full-stack Next.js, not a split API.** Chosen over the plan's separate
  Fastify service: one deployable, no CORS, no duplicated types. The trade is
  that API and UI cannot scale independently. Everything under `src/lib/` is
  framework-agnostic, so extracting a service later is mechanical.
- **Storage behind an interface.** `VideoProvider` has three implementations.
  The database stores bucket-relative paths so a provider swap is configuration.
- **Read queries live in `src/lib/queries/`.** Pages and route handlers do not
  build SQL. This is also what makes queries testable without a request context.
- **Cookie-based playback authorisation.** See
  [storage-and-delivery.md](storage-and-delivery.md); this is the highest-stakes
  decision in the system.
- **Rollups, not live aggregation.** Nothing user-facing reads the events table.
- **Clock in the read path, not a cron.** Scheduled publishing is a predicate on
  `published_at`, so a release cannot fail because a job did not run.

## External Dependencies

| Service           | Purpose                | If it goes down                              |
|-------------------|------------------------|----------------------------------------------|
| Neon Postgres     | All state              | Site is down; `/api/health` returns 503      |
| Vercel            | Hosting, crons         | Site is down                                 |
| Cloudflare R2+CDN | Media delivery         | Metadata renders, nothing plays              |
| Google IMA / GAM  | Video ads              | Ads fail open — playback continues unaffected |

## Scalability & Limits

- **Current scale:** trivial. 5 sample titles, synthetic media.
- **First bottleneck:** the home page is now per-request because the billboard
  reflects the viewer's list. Redis caching of the shared rails (plan §8) is the
  intended next step, not caching the whole page.
- **Events volume:** ~18M rows/month at 10k DAU. Partitioned monthly, pruned at
  35 days, so pruning is `DROP TABLE`. Beyond ~100k DAU this belongs in
  ClickHouse.
- **Transcode throughput:** ~20 hours of source per day per 8-vCPU worker.
  Horizontal — workers coordinate only through the jobs table.
- **Hobby plan caps crons at two, daily.** Anything needing finer scheduling
  must be designed out (as scheduled publishing was) or the plan upgraded.

## What NOT to Do

- Do not sign segment URLs per session. It is the one mistake that makes the
  business model fail rather than merely degrade.
- Do not proxy uploads or media through a route handler.
- Do not query the database directly from a page or component.
- Do not aggregate the raw events table for anything user-facing.
- Do not use `VIDEO_PROVIDER=local` for real traffic — it serves media as
  deployment assets at platform bandwidth rates.
- Do not put `now()` in an index predicate; it is not immutable.
