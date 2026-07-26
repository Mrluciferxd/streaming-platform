# Analytics

## What this subsystem does

Records what viewers actually watch, and turns it into the numbers the product
reads: the trending rail, `videos.view_count`, the admin dashboard, and — later
— creator revenue share.

## How it is structured

```
src/lib/player/analytics.ts     Client batcher (buffer, flush, beacon)
src/app/api/events/route.ts     Ingest: validate, filter, insert
src/db/schema-analytics.ts      Query-time definitions (NOT drizzle-managed)
drizzle/0001_analytics.sql      Real DDL: partitioning, rollup functions
src/app/api/cron/rollup/route.ts  Nightly: roll up, provision, prune
```

Tables: `video_events` (range-partitioned by month), `video_stats_daily`,
`video_retention`.

## Conventions and rules

- **Nothing user-facing reads `video_events`.** Everything reads the rollup.
- Raw events are kept 35 days; pruning is `DROP TABLE` on a partition.
- The rollup recomputes rather than accumulates, so a retry cannot double-count.
- `videos.view_count` is owned by `rollup_video_stats`. Never write it on the
  playback path.

## Known gotchas

**Watch time comes from wall-clock deltas, not `currentTime`.** At 2× playback
`currentTime` advances twice as fast, and a seek advances it without anyone
watching. Both would inflate the number that ranks trending and computes
revenue share. Deltas are also capped at 300s so a backgrounded tab cannot
report hours in one interval.

**Events are batched, not sent live.** One viewer generates a progress event
every few seconds, so per-event requests would mean roughly one round trip per
second per concurrent viewer. Flush is every 15s, plus `sendBeacon` on unload —
a normal fetch is cancelled when the document goes away, which would drop the
final and most valuable events of a session.

**The rollup runs on *yesterday*.** A cron reporting `videosRolledUp: 0` right
after you send test events is correct, not broken — today is still accumulating.

**`video_events` has no foreign key to `videos`.** An FK check per row is too
expensive on this insert path, so the ingest endpoint validates video ids in one
query instead. Without that, anyone could fill a partition with rows referencing
nothing.

**Unknown event types are dropped, not rejected.** A newer client sending an
event this deployment does not know about should lose that one event, not have
its whole batch 400'd.

**Don't seed fake view counts.** The rollup only corrects videos that have real
stats, so an invented number on an unwatched video is never corrected and sits
there permanently. The seed used to do this; twelve rows had to be cleared.

**The events table is not in `drizzle-kit`'s schema.** drizzle-kit cannot
express `PARTITION BY`, so including it would make every `generate` try to
"fix" the partitioned table. `schema-analytics.ts` exists for query typing only;
`drizzle/0001_analytics.sql` is the real DDL.

**Partition maintenance is two months ahead.** A missed run degrades to the
default partition rather than failing inserts — that is what the default
partition is for.

## How it is tested

`npm run check:analytics` (needs a running server) walks the whole chain:
ingest → `video_events` → `rollup_video_stats` → `video_stats_daily` →
`videos.view_count`, plus validation (malformed → 400, implausible watch time →
400, unknown video silently dropped, oversized batch → 400) and idempotency of
the rollup.

Verified in production: 8 events produced exactly 1 view and 15 watch-seconds
in the daily rollup, matching what was sent.

## Related

- [player.md](player.md) — where events originate
- [database.md](database.md) — partitioning and rollup functions
- [admin.md](admin.md) — the dashboard that reads the rollup
