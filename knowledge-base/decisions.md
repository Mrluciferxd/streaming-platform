# Decisions

## Decision: Playback authorisation by cookie, never by signed segment URL
**Date**: 2026-07-26
**Status**: Accepted
**Context**: Plan §0 makes the business viable only if the CDN absorbs nearly
all segment requests. Plan §11 asks for time-limited, IP-bound tokens on
playback URLs. Implemented literally, those two requirements destroy each other.
**Decision**: The token is an HMAC in a cookie scoped to the media path, checked
by an edge Worker. Segment URLs are identical for every viewer.
**Alternatives Considered**: Signing each segment URL — every viewer gets a
unique cache key, so the edge cache stops working, every segment becomes an
origin read, and a ~$75/month delivery bill becomes thousands. Rejected. Signing
only the master playlist while leaving segments open — weaker, and the cookie
approach costs nothing extra.
**Consequences**: The CDN hostname **must** be a subdomain of the app domain or
the browser will not send the cookie. Cache key must never include the cookie.
A viewer can share their own cookie; that is accepted, and no cache-friendly
scheme prevents it. Plan §11's own goal is only to make casual scraping
annoying.

## Decision: Next.js full-stack instead of a separate Fastify API
**Date**: 2026-07-26
**Status**: Accepted
**Context**: Plan §3 diagrams a separate API service. The team is effectively
one or two people.
**Decision**: One Next.js app; route handlers are the API. A separate worker
process handles transcoding.
**Alternatives Considered**: The monorepo in the plan — roughly twice the setup
and operational surface for a team this size.
**Consequences**: One deployable, no CORS, no duplicated types. API and UI
cannot scale independently. Everything under `src/lib/` is framework-agnostic,
so extraction later is mechanical rather than a rewrite.

## Decision: Postgres job queue rather than BullMQ on Redis
**Date**: 2026-07-26
**Status**: Accepted
**Context**: Plan §4 specifies BullMQ. Transcoding is tens to hundreds of jobs a
day, each running minutes — the opposite of the shape Redis is good at.
**Decision**: `SELECT … FOR UPDATE SKIP LOCKED`.
**Alternatives Considered**: BullMQ — correct at thousands of jobs per minute,
which this workload will never reach.
**Consequences**: Enqueue commits in the same transaction as the video row, so
there is never a video marked `processing` with no job. No second stateful
service. Redis is still the right answer for the query cache and would be for
rate limiting; it is simply not needed to move jobs.

## Decision: scrypt rather than bcrypt or argon2
**Date**: 2026-07-26
**Status**: Accepted
**Context**: Plan §11 names bcrypt/argon2. Both are native modules.
**Decision**: `node:crypto` scrypt, N=32768, r=8, p=1.
**Alternatives Considered**: argon2id is the better primitive, but on a
serverless target a native module means a compiled binary in the bundle and a
build that breaks when the runtime's Node version moves.
**Consequences**: No dependency, nothing to compile. The stored hash carries a
version tag (`s1$…`), so migrating to argon2id lazily on next login is already
possible. Revisit if this moves to long-lived servers.

## Decision: Server-side sessions rather than JWTs
**Date**: 2026-07-26
**Status**: Accepted
**Decision**: Opaque random token in the cookie; only its SHA-256 is stored.
**Consequences**: A database leak yields no usable sessions, and logout revokes
genuinely rather than clearing a cookie the holder may have copied. Costs one
indexed lookup per authenticated request. SHA-256 rather than a slow KDF is
correct here — the token is 256 bits of CSPRNG output, so there is no
low-entropy space to brute force.

## Decision: Postgres full-text search rather than Meilisearch
**Date**: 2026-07-26
**Status**: Accepted
**Context**: Plan §4 specifies Meilisearch for typo tolerance.
**Decision**: `websearch_to_tsquery` against a generated `search_vector`, using
the `simple` configuration.
**Alternatives Considered**: Meilisearch — the right answer once the library is
large, but another service to run and back up for a catalogue of this size.
**Consequences**: Single-digit milliseconds at current scale, no typo tolerance.
`simple` rather than `english` on purpose: there is no Hindi or Gujarati
stemmer, and English stemming makes transliterated titles worse. Swap when
result quality is the actual complaint.

## Decision: Scheduled publishing is a read-path predicate, not a cron
**Date**: 2026-07-27
**Status**: Accepted (supersedes the `/api/admin/publish-due` sweep)
**Context**: Scheduling originally parked rows at `ready` with a future
`published_at` and relied on a sweep to flip them, because the public queries
filtered on status alone. The deploy was then rejected: this account's plan
permits only daily crons.
**Decision**: Publish immediately with a future `published_at`, and filter on
the timestamp in `publiclyVisible`.
**Alternatives Considered**: Lowering the sweep to daily — a title scheduled for
9am could go live at midnight the next day with nothing explaining the gap.
Upgrading the plan — solves the symptom and leaves a release depending on a job.
**Consequences**: A schedule cannot silently fail, because there is nothing left
to fail. Visibility is now one predicate used in nine places instead of three
slightly different spellings. `now()` cannot live in an index predicate, so
Postgres uses `videos_published_idx` for status/deleted and filters the
timestamp on what it returns. `/api/admin/publish-due` is kept for rows the old
behaviour stranded at `ready`.

## Decision: Ladder rungs match the source's shorter side
**Date**: 2026-07-26
**Status**: Accepted
**Context**: Matching on height is the obvious reading of plan §5.3 and is wrong
for portrait video, which is a large share of uploads on a mobile-first Indian
platform.
**Decision**: Select rungs against `min(width, height)`.
**Consequences**: A 480×854 phone video is labelled 480p at 1400 kbps — the same
pixel count and bitrate as a landscape 854×480. Height-matching would have
selected a "720p" rung and encoded 405×720 at 2800 kbps, roughly three times the
bitrate those pixels need, paid on every byte delivered.

## Decision: `node:test` rather than Vitest or Jest
**Date**: 2026-07-27
**Status**: Accepted
**Context**: Verification had accumulated as standalone scripts each hand-rolling
its own pass/fail counting.
**Decision**: Node's built-in test runner, run through `tsx`.
**Alternatives Considered**: Vitest — better watch mode and assertions, but a
dependency and a config surface for a suite that is mostly integration checks
against a real database.
**Consequences**: No dependency. Checks needing infrastructure skip with the
reason printed; `CHECK_STRICT=1` turns an unmet precondition into a failure so
CI cannot go green on a machine where nothing ran.

## Decision: Dark-to-light redesign, portrait key visuals
**Date**: 2026-07-26
**Status**: Accepted (supersedes the Netflix-style dark catalogue)
**Context**: The product pivoted to anime, and the requested look was light and
rounded.
**Decision**: Light warm palette, Quicksand + Baloo 2, 2:3 portrait cards,
SUB/DUB on the resting card.
**Consequences**: Cards need real key art; a 16:9 frame cropped to 2:3 loses the
composition, so `videos.portrait_url` exists and falls back to the poster.
SUB/DUB is on the resting card because for anime viewers it is the first filter
applied, not trivia. Tailwind v4 tokens must be used as plain utilities — see
the critical rules in README.
