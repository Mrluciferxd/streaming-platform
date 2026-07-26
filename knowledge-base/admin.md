# Admin

## What this subsystem does

The operator surface: upload, library, metadata, publishing, categories,
analytics dashboard, transcode dead-letter queue, audit log.

## How it is structured

```
src/app/admin/            Pages (library, upload, videos/[id], categories,
                          analytics, queue, audit)
src/app/api/admin/        Handlers (videos, status, categories, reorder,
                          jobs retry, publish-due)
src/lib/auth/require-role.ts   The gate
src/lib/queries/admin.ts       Read queries + isUniqueViolation
```

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
under concurrent edits.

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

## How it is tested

Verified manually against the live database during construction: the full role
matrix (anonymous, viewer, creator → 404 everywhere; moderator, admin → 200),
the complete status lifecycle with every 409 precondition, category CRUD and
reorder, analytics charts against temporary fixture rows, dead-letter retry.

No automated tests. `scripts/smoke.ts` asserts only that the surface is closed
to anonymous callers — and asserts a JSON 404 rather than a status code, because
of ISSUE-004.

Two test accounts remain in the database (`admin-test@localhost.test`,
`viewer-test@localhost.test`); deleting them would null the actor on the audit
rows they generated.

## Related

- [auth.md](auth.md) — the role gate
- [video-pipeline.md](video-pipeline.md) — what upload feeds
