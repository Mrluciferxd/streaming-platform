# Known Issues

Never delete entries — mark them resolved.

## ISSUE-001: R2 storage path has never run against a real bucket

**Status**: Open
**Severity**: High
**Discovered**: 2026-07-26
**Symptom**: Everything about R2 is typechecked and nothing more. Multipart
upload, `downloadToFile`, `uploadDirectory`, presigned parts and prefix deletion
have never executed against Cloudflare. The deployment runs
`VIDEO_PROVIDER=local`, whose `listUploadedParts()` always returns `[]`, so even
the admin panel's upload flow cannot exercise the resume path.
**Root Cause**: No bucket has been provisioned.
**Workaround**: `VIDEO_PROVIDER=local` for development and the demo deploy.
**Fix**: Provision R2, then run `npm run check:r2` — it exercises the whole
`VideoProvider` contract and names any missing variable. Two things will bite
immediately and are already handled in code but unverified: the CSP
`connect-src` must include the R2 S3 endpoint (it does, derived from
`R2_ACCOUNT_ID`), and the bucket needs a CORS rule allowing `PUT` from the app
origin.
**Regression Test**: `scripts/check-r2.ts` (skips without credentials)

## ISSUE-002: Untyped Drizzle parameters take their type from a sibling

**Status**: Resolved
**Severity**: Critical
**Discovered**: 2026-07-27
**Resolved**: 2026-07-27
**Symptom**: `GET /api/history` returned 500 for every signed-in viewer.
Continue Watching was empty everywhere.
**Root Cause**: In `sql\`coalesce(${videos.durationSec}, ${MIN_RESUME_SECONDS})
* ${MIN_RESUME_FRACTION}\``, Drizzle sends interpolated values as *untyped*
parameters. Postgres resolved the `coalesce` parameter to `integer` from its
sibling column, then tried to parse the `0.05` fraction as an integer:
`invalid input syntax for type integer: "0.05"`. Typecheck, build and all 69
tests passed — a type error inside a raw SQL template is invisible to every one
of them.
**Workaround**: None; the endpoint was unusable.
**Fix**: Cast every interpolated parameter explicitly (`${x}::numeric`). The
query moved to `src/lib/queries/history.ts` so it can be run in a test without a
request context — inline SQL in a route handler is what made it untestable.
**Regression Test**: `scripts/check-history.ts` — "runs the band query without
erroring"

## ISSUE-003: A flat resume floor makes short content unresumable

**Status**: Resolved
**Severity**: Medium
**Discovered**: 2026-07-27
**Resolved**: 2026-07-27
**Symptom**: Videos shorter than ~16s could never appear in Continue Watching.
**Root Cause**: The lower bound was a flat 15 seconds while "finished" was 95%
of runtime. For a 12-second clip every position clearing the floor is at or past
the end, so a title was simultaneously resumable and finished — an empty band.
Hidden until positions were clamped to the catalogue duration, because the old
code stored impossible positions (15s into a 12s video) and displayed them.
Music and AMV are top-level categories here, so short content is not a corner
case.
**Fix**: The floor is now `least(15s, 5% of runtime)`, applied identically in
`src/lib/queries/history.ts` and the localStorage path in
`src/lib/player/resume.ts` — if the two disagree, Continue Watching differs
depending on whether the viewer is signed in.
**Regression Test**: `scripts/check-history.ts` — "shows a short video, whose
band a flat 15s floor would leave empty" and "keeps the absolute floor for long
content"

## ISSUE-004: Vercel returns HTTP 200 for unknown paths carrying an Authorization header

**Status**: Accepted Risk (platform behaviour, not ours)
**Severity**: Medium
**Discovered**: 2026-07-27
**Symptom**: On this deployment any nonexistent path answers **200** when the
request carries `Authorization: Bearer …` or `Basic …`. The body is the
not-found HTML with `x-matched-path: /_not-found`. Other headers (`Cookie`,
`X-Foo`) correctly return 404. Reproduced on three distinct paths.
**Root Cause**: Vercel platform behaviour. Not reproducible in the application.
**Impact**: A monitoring probe that authenticates sees 200 for endpoints that do
not exist — which is exactly how a missing cron route stays invisible.
**Workaround**: Assert on the response *body or a header*, never status alone,
for any authenticated probe. `scripts/smoke.ts` asserts a JSON 404 on the admin
surface for this reason.
**Fix**: None available to us.

## ISSUE-005: Duplicate slug returned 500 instead of 409

**Status**: Resolved
**Severity**: Low
**Discovered**: 2026-07-26
**Resolved**: 2026-07-26
**Root Cause**: Drizzle wraps driver errors and its own `message` is the SQL
text, so matching a constraint name in the message never fires. The real
`PostgresError` with SQLSTATE 23505 is on `cause`.
**Fix**: `isUniqueViolation()` in `src/lib/queries/admin.ts` walks the cause
chain.
**Regression Test**: Covered manually during admin verification; no automated
test yet.

## ISSUE-006: Machine disk pressure and Desktop indexer stalls

**Status**: Open (environmental)
**Severity**: Low
**Discovered**: 2026-07-26
**Symptom**: `git add`/`git status` hung for minutes while the project lived on
the Desktop; `next build` and `vercel deploy` intermittently stalled. Data
volume is at ~95% (12 GB free).
**Root Cause**: A Spotlight/Xcode indexer holding the working tree, plus disk
pressure.
**Workaround**: The project was moved to `~/Downloads`, which resolved the git
stalls immediately. Free disk space when convenient.

## ISSUE-007: Ads cannot be verified without an ad-network account

**Status**: Open
**Severity**: Low
**Discovered**: 2026-07-27
**Symptom**: The VAST/IMA integration path is implemented and typechecked but
has only been reasoned about, not exercised against a real GAM account or a live
VAST tag.
**Workaround**: Ads are off by default and fail open — an ad that does not load
falls straight through to content.
**Fix**: Configure GAM, then verify fill, frequency capping and the
`ad_impression` / `ad_complete` telemetry against real inventory.

## ISSUE-008: Demo media 404 on production — .vercelignore re-include miss

**Status**: Resolved
**Severity**: High
**Discovered**: 2026-08-04
**Resolved**: 2026-08-04
**Symptom**: Images and video returned 404 on the production deploy
(`streaming-platform-red.vercel.app`). The `/api/playback/[slug]` endpoint
returned 200 with `masterUrl`/`posterUrl` pointing at `/media/v/...` paths
(`VIDEO_PROVIDER=local`), but those paths 404'd. The homepage rendered with
broken `<img>` (the `_next/image` proxy 404'd on the underlying file).
**Root Cause**: `.vercelignore` had a lone `!public/media` to ship the
gitignored demo media with CLI deploys. `public/media` is gitignored
(`.gitignore:26`), and a negation re-includes only the named path — the
directory entry — not its children. Git's "it is not possible to re-include a
file if a parent directory of that file is excluded" rule kept the contents
out; the CLI uploader honored `.gitignore` as default exclusions, so the
directory uploaded empty.
**Fix**: `.vercelignore` now reads `!public/media/` and `!public/media/**`
— the first re-opens the directory, the second re-includes its contents.
Verified: `portrait.png`, `master.m3u8`, `poster.jpg` and the `_next/image`
proxy all return 200 on the post-fix production deploy; smoke 37/37.
**Regression Test**: After any future change to `.vercelignore` or
`.gitignore` touching `public/media`, redeploy and `curl -sI` one portrait
and one master.m3u8 against the new deployment URL.
**Commit**: `7c2030c`
