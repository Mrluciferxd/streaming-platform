# SakuraTV — Ad-supported anime streaming (India-first)

> Free-to-watch anime catalogue. Revenue from advertising. Self-managed library,
> self-hosted transcoding, zero-egress delivery.

Built against `~/Downloads/streaming-platform-development-plan.md`. Section
references throughout the code (`plan §0`, `plan §8`) point at that document.

## Tech Stack

| Layer        | Technology                                              |
|--------------|---------------------------------------------------------|
| Language     | TypeScript 7 (native compiler)                          |
| Framework    | Next.js 16 (App Router, Turbopack), React 19            |
| Styling      | Tailwind v4 (`@theme` tokens), Quicksand + Baloo 2      |
| Database     | PostgreSQL 17 (Neon, pooled)                            |
| ORM          | Drizzle                                                 |
| Hosting      | Vercel (Hobby plan — 2 daily crons max)                 |
| Auth         | Email + password, scrypt, server-side sessions          |
| Player       | hls.js, custom controls                                 |
| Storage      | Provider adapter — Cloudflare R2 / Bunny / local        |
| Queue        | Postgres `SELECT … FOR UPDATE SKIP LOCKED`              |
| Test Runner  | `node:test` (built in, no dependency)                   |

## Directory Structure

```
src/
  app/                  App Router — pages and route handlers (this is the API)
    admin/              Operator surface (404s for non-operators)
    api/                All HTTP endpoints
    (auth)/account/     Sign in / register
    watch/[slug]/       Watch page
    series/[slug]/      Series page with episode list
    c/[slug]/           Category browse
  components/
    player/             hls.js player, controls, seek bar, ad controller
    ads/                Display ad slots
  db/
    schema.ts           Everything drizzle-kit manages
    schema-analytics.ts Partitioned events + rollups (hand-written DDL)
    schema-ops.ts       Rate-limit counters (hand-written DDL)
  lib/
    video/              Storage providers, encoding, HLS, playback tokens
    queries/            All read queries — nothing queries the DB from a page
    jobs/queue.ts       Postgres job queue
    auth/               Password hashing, sessions, role gate
    ads/                VAST/IMA integration
    player/             Client-side resume, thumbnails, telemetry batcher
worker/                 Transcode worker (separate long-running process)
drizzle/                Migrations (0000/0002/0003/0004 generated, rest by hand)
infra/cloudflare/       Edge Worker enforcing the playback cookie
scripts/                Tests, seeds, operational checks
knowledge-base/         This directory
```

## Critical Rules

- **Never sign individual segment URLs.** The playback token goes in a *cookie*.
  Per-session segment URLs give every viewer a unique cache key, which collapses
  the CDN hit ratio and turns a ~$75/month delivery bill into thousands. See
  [storage-and-delivery.md](storage-and-delivery.md).
- **The CDN host must be a subdomain of the app domain** (`example.com` +
  `cdn.example.com`), or the browser will not attach the playback cookie.
- **Tailwind v4 tokens are plain utilities** — `bg-primary`, `text-ink`,
  `font-display`. The v3 form `bg-[--color-ink]` emits invalid CSS and is
  **silently dropped**. This shipped once and rendered the whole site in Times.
- **Nothing outside `src/lib/video/` may import `./r2`, `./bunny` or `./local`.**
  Import `getVideoProvider()` from `src/lib/video`.
- **The database stores bucket-relative paths, never URLs.** Resolve with
  `provider.publicUrl()` in the query layer, never in a component.
- **Raw SQL in Drizzle templates sends untyped parameters.** Cast explicitly
  (`${x}::numeric`) or Postgres infers the wrong type at runtime. This caused a
  production 500 — see ISSUE-002.
- **Money is integer paise (bigint).** Never float.
- Deploy: `npx vercel deploy --prod --yes`. Migrations do **not** run on deploy;
  run `npm run db:migrate` yourself.

## Quick Facts

| Key          | Value                                              |
|--------------|----------------------------------------------------|
| Repo         | https://github.com/Mrluciferxd/streaming-platform  |
| Prod URL     | https://streaming-platform-red.vercel.app          |
| DB           | Neon Postgres 17, project `streaming-platform`     |
| CI/CD        | None yet — deploys are manual from the CLI         |
| Test Command | `npm test` (77 tests), `npm run smoke -- <url>`    |

## Reading Order

| File                                                 | When to Read                          |
|------------------------------------------------------|---------------------------------------|
| README.md                                            | Always first                          |
| [architecture.md](architecture.md)                   | Before touching structure             |
| [decisions.md](decisions.md)                         | Before changing an architectural choice |
| [known-issues.md](known-issues.md)                   | Before debugging anything             |
| [active-context.md](active-context.md)               | Every session                         |
| [testing.md](testing.md)                             | Before writing or changing tests      |
| [storage-and-delivery.md](storage-and-delivery.md)   | Anything touching media or the CDN    |
| [video-pipeline.md](video-pipeline.md)               | Upload, transcode, HLS                |
| [auth.md](auth.md)                                   | Sessions, passwords, roles            |
| [analytics.md](analytics.md)                         | Telemetry, rollups, trending          |
| [database.md](database.md)                           | Schema, migrations, partitioning      |
| [admin.md](admin.md)                                 | Operator surface                      |
| [ads.md](ads.md)                                     | Monetisation                          |
| [player.md](player.md)                               | Playback, ABR, resume                 |
| [changelog.md](changelog.md)                         | Tracing a regression                  |
