# Series and Episodes

## What this subsystem does

Organises the catalogue around the thing a viewer actually searches for — a
series — rather than the episodes alone. Anime is episodic: the show is the
brand, the season is a unit of broadcast, and an episode is what gets watched
once.

The series row carries catalogue-facing metadata (synopsis, key art, studio,
broadcast cour) once, instead of repeating it on every episode video where it
would drift the moment one row was edited. The episodes join table places a
video at a `(season_no, episode_no)` slot, owns the per-episode title and
synopsis, and is the single source of truth for ordering on the series page
and next/previous on the watch page.

## How it is structured

```
src/db/
  schema.ts                The `series`, `episodes` tables; the unique indexes
src/lib/queries/
  series.ts                Public read queries (series page, episode list, next/prev)
  admin.ts                 Admin read/write queries + audit helpers
src/app/api/admin/series/
  route.ts                 GET list, POST create
  [id]/route.ts            GET read, PATCH update, DELETE delete
  [id]/episodes/route.ts   GET list, POST (attach / update / detach — discriminated body)
  [id]/reorder/route.ts    POST array rewrite of (season_no, episode_no)
src/app/admin/series/
  page.tsx                 List of every series + new-series form
  SeriesManager.tsx        Client component for the list
  [id]/page.tsx            Read series, its episodes, audit trail — pass to editor
  [id]/SeriesEditor.tsx   Metadata form + ordered episode list + add-episode picker
src/app/admin/videos/[id]/
  VideoEditor.tsx          "Series placement" panel — attach/detach from the video side
src/app/series/[slug]/     Public series page (renders season-grouped episode list)
src/app/watch/[slug]/      Watch page uses `getEpisodeContext` for next/previous
```

The admin and public queries are deliberately separate (see the comment at the
top of `queries/admin.ts`): admin queries show every row including drafts,
failures, takedowns; public queries never see anything not visible, and page
by keyset on the hot path. Both share the same schema.

## Conventions and rules

- **A series is public as soon as one of its episodes is.** There is no
  separate publish flag on `series` — visibility is derived from whether any
  episode's video is `publiclyVisible`. A second switch on the series would only
  be a way to publish a catalogue page with nothing to watch behind it.
- **A video belongs to at most one series.** Enforced by the
  `episodes_video_key` unique index, and surfaced in the admin picker as a
  greyed-out "Already on X" row and at the API layer as 409
  `already_attached`, never as a 500.
- **`(season_no, episode_no)` is unique per series.** Enforced by
  `episodes_series_season_ep_key`; surfaced at the API as 409 `slot_taken`.
- **Reordering rewrites the whole array, not pairwise swaps.** The new order is
  a sequence property, and swaps under concurrent edits race (same reasoning as
  `categories/reorder`). The reorder endpoint takes the full ordered list.
- **The series row does not own categories.** A series belongs to a category
  because its episodes do — a second taxonomy on `series` would be a second
  thing to keep in sync. See `listSeriesByCategory` in
  `src/lib/queries/series.ts`.
- **`total_episodes` is an announced number, not a count of rows.** While a
  cour airs, "Ep 7 of 24" is what a viewer wants, and the 24 is declared by the
  broadcaster months before it can be counted. Schema check constraint makes it
  `> 0` and nullable.
- **Status is an enum, not a date comparison.** `hiatus` is separate from
  `completed` on purpose — a paused series must drop out of the airing rail
  without being presented as finished.
- **Stored paths are bucket-relative, never URLs.** Series art (`posterUrl`,
  `portraitUrl`, `bannerUrl`) and episode `thumbnailUrl` follow the same rule
  as the rest of the platform: `provider.publicUrl()` resolves them in the
  read path, which is what keeps a storage swap a config change.
- **Every admin write goes to `audit_log`.** `series.create/update/delete` and
  `episode.attach/update/detach`. The audit entity type is now `'series'` or
  `'episode'` (see the `entityType` widening in `recordAudit`).

## Known gotchas

**Reordering two adjacent episodes touches both rows.** The admin UI swaps
episode numbers, which collides with `episodes_series_season_ep_key` if naively
done in place — the unique constraint would reject the intermediate state
where two rows share a number. The admin API updates each independently; the
intermediate state is not visible to viewers because the episodes pair is
read through `episodes_series_season_ep_key`'s index, and a pair of single-row
updates inside two separate HTTP calls will briefly produce two rows sharing
the same number if the second call is observed, which is why full-array reorder
is the recommended path for moving distant episodes. For adjacent swaps this is
a transitory 1-RTT gap.

**Detaching an episode leaves the video in the library.** The video row, its
media, its watch history and its revenue attribution all survive — a series
going away (or a video being removed from one) is reversible by reattaching.
Cascade is on `episodes`, not `videos`.

**The picker excludes videos already on the *current* series.** A video that
is already episode 3 cannot be added again as episode 5 — the operator edits
the existing episode row's number instead. The picker shows videos on *other*
series as greyed-out ("Already on X") rather than hiding them, so the row
explains itself.

**Slug changes re-point `/series/<slug>`.** The audit trail records the old slug
so a re-publish can be tracked back. Anything linking to the old URL is now a
404.

**`getEpisodeContext` walks the whole ordered list to compute next/previous**
rather than running two window-function queries — because the list is already
on the page (the watch page renders the episode picker), and because window
functions would not survive a gap in numbering that an unpublished or withdrawn
episode creates.

## How it is tested

`npm test` (87 pass) covers the new admin surface via
`scripts/check-series-admin.ts`: create a timestamped fixture series, attach a
fixture video, assert the audit row, detach, assert the audit row, delete,
clean up — plus the `listEpisodeCandidates` picker and the SQLSTATE 42702
regression. The read side is also exercised by the smoke suite against a
deployment. Browser verification is still the gate before deploy; the
automated check covers the query layer only.

The public read side (`getSeriesBySlug`, `listSeriesByCategory`,
`listAiringSeries`, `getEpisodeContext`) is indirectly exercised by the smoke
suite against a deployment.

## Related

- [admin.md](admin.md) — the operator surface series lives in; the gaps that
  remain after this (reports queue, user management, comment moderation,
  payouts)
- [database.md](database.md) — `series`, `episodes` schema and check constraints
- [video-pipeline.md](video-pipeline.md) — what produces the per-episode
  videos the join rows point at
