# Admin

## What this subsystem does

The operator surface: upload, library, metadata, publishing, **series and
episodes**, categories, analytics dashboard, transcode dead-letter queue, audit
log.

## How it is structured

```
src/app/admin/            Pages (library, upload, series, videos/[id],
                          categories, analytics, queue, audit)
src/app/api/admin/        Handlers (videos, status, series + episodes,
                          categories, reorder, jobs retry, publish-due)
src/lib/auth/require-role.ts   The gate
src/lib/queries/admin.ts       Read queries + isUniqueViolation + audit
src/app/admin/series/          Series list, new-series form, series editor
                               (the editor hosts the ordered episode list and
                               the add-episode picker)
```

The `VideoEditor` (`src/app/admin/videos/[id]/VideoEditor.tsx`) hosts a
"Series placement" panel as well — the same join can be reached from either
side. Both paths write to `audit_log`.

## Conventions and rules

- Gate every page with `requireAdminPage()` and every handler with
  `requireAdminApi()`. Both answer 404.
- Admin and moderator only. Moderators are included because takedown is their
  job and the IT Rules 15-day clock does not pause for an admin to be available.
- Every state change writes to `audit_log` inside the same transaction.
- Takedown requires a stated reason — a takedown without one is not a
  compliance record.

## Known gotchas

**404, not 403.** See [auth.md](auth.md).

**Category reorder rewrites the whole array**, not pairwise swaps, which race
under concurrent edits. Episode reorder follows the same pattern — see
[series.md](series.md).

**Scheduling publishes immediately with a future `published_at`.** Visibility is
a read-path predicate now, so no cron is involved — see
[decisions.md](decisions.md). `/api/admin/publish-due` remains for rows the old
behaviour stranded at `ready`.

**Takedown does not purge media from storage.** `/api/playback/[slug]` refuses
anything not publicly visible, so it leaves the public surface immediately;
deleting bytes would make restore meaningless and should stay a deliberate
separate step.

**Upload is admin/moderator only, not creators.** Creator self-serve upload is a
larger question — quotas, ownership, moderation — than a role tuple.

**The uploader treats a 403 on a part as an expired signature**, not a failure.
Presigned URLs live an hour and a large upload outlives that.

**The admin surface is only query-layer tested.** The series/episodes surface
(added 2026-07-31) typechecks and `scripts/check-series-admin.ts` (added
2026-08-01) exercises the full CRUD path against a live Postgres, including the
`listEpisodeCandidates` picker and a SQLSTATE 42702 regression. The suite is
87 pass, 0 fail. But no browser/E2E check exercises the panel UI — browser
verification is still the gate before deploy.

## Surfaces not yet built

Schema exists, panel doesn't surface them:

- **IT-Rules grievance/reports queue** — `reports` table with `due_at` (the
  15-day clock) and `reports_open_due_idx` is compliance scaffolding; no
  `/admin/reports` page, no handler. The callback-operator workflow IT Rules
  2021 actually requires publishers to operate does not exist yet.
- **User / account management** — no `/admin/users` page; no operator surface
  to promote a viewer to moderator, soft-delete a user, or see who has which
  role.
- **Comment moderation** — `comments` table includes `comments_moderation_idx`
  for a pending-queue scan; no query, no UI. The public watch page has no
  comment box either.
- **Creator & payouts surface** — `creators`, `revenue_shares`, `payouts`
  defined; no onboard form, no mark-paid, and the writer that produces
  `revenue_shares` from the rollup does not exist yet.
- **Per-video analytics drill-down** — `/admin/analytics` shows portfolio-wide
  totals + top-10; `retentionCurve(videoId)` exists but is not surfaced.

## How it is tested

Verified manually against the live database during construction: the full role
matrix (anonymous, viewer, creator → 404 everywhere; moderator, admin → 200),
the complete status lifecycle with every 409 precondition, category CRUD and
reorder, analytics charts against temporary fixture rows, dead-letter retry,
and — as of 2026-07-31 — series/episodes CRUD by reasoning about it. **The
series/episodes surface has not been exercised against a browser yet.**

No automated tests. `scripts/smoke.ts` asserts only that the surface is closed
to anonymous callers — and asserts a JSON 404 rather than a status code, because
of ISSUE-004.

Two test accounts remain in the database (`admin-test@localhost.test`,
`viewer-test@localhost.test`); deleting them would null the actor on the audit
rows they generated.

## Related

- [auth.md](auth.md) — the role gate
- [series.md](series.md) — series & episodes admin, the join conventions
- [video-pipeline.md](video-pipeline.md) — what upload feeds
