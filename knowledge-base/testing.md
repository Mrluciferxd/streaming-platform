# Testing

## Test Frameworks in Use

`node:test` (built into Node 26) executed through `tsx` for TypeScript. No test
dependency. Assertions are `node:assert/strict`.

## How to Run Tests

| Command                        | What it runs                                        |
|--------------------------------|-----------------------------------------------------|
| `npm test`                     | Full suite — 87 tests, 19 suites                    |
| `npm run check:ladder`         | ABR rung selection across aspect ratios (pure)      |
| `npm run check:slug`           | URL slugs, including Indic scripts (pure)           |
| `npm run check:queue`          | Job queue against a real Postgres                   |
| `npm run check:rate-limit`     | Fixed-window counters against a real Postgres       |
| `npm run check:sweep`          | Abandoned-upload sweeper, invokes the route handler |
| `npm run check:history`        | Continue Watching band + write path                 |
| `npm run check:series-admin`   | Series/episode CRUD + candidate picker (real PG)   |
| `npm run check:analytics`      | Telemetry ingest → rollup (needs a running server)  |
| `npm run check:token`          | App/Worker playback-token interop (needs a server)  |
| `npm run check:r2`             | Full VideoProvider contract (needs R2 credentials)  |
| `npm run smoke -- <url>`       | Black-box suite against a deployment — 37 tests     |
| `npm run transcode:local`      | Real FFmpeg run; `npm run verify:hls` checks output |

## Test File Conventions

Tests live in `scripts/` as `check-*.ts`, not beside the code. That is
deliberate: almost all of them are integration checks that need a real database,
a real FFmpeg, or a deployed server, and keeping them together makes the
infrastructure each one needs obvious. Pure-logic checks (ladder, slug) are in
the same place for one command.

`scripts/support.ts` holds the precondition/skip helper. The distinction it
enforces: a *precondition* (no database, no server, no credentials) is a reason
to skip; an *assertion* is a reason to fail. Conflating them is how a suite ends
up green on a machine where nothing ran. `CHECK_STRICT=1` turns any unmet
precondition into a failure — set it in CI once the infrastructure exists.

## What Must Be Tested

- **Raw SQL must be executed by a test.** ISSUE-002 shipped a 500 to production
  through typecheck, build and 69 green tests, because a type error inside a
  Drizzle `sql` template is invisible to all three. If a query is not run by a
  test, it is not covered, whatever the coverage number says.
- **Queries belong in `src/lib/queries/`**, not inline in route handlers —
  inline SQL cannot be exercised without a request context, which is precisely
  why the history endpoint was untested.
- Auth rules need an allowed case and a denied case.
- Cron handlers are invoked directly, with real rows, not mocked.
- Anything touching money or watch time needs an explicit over/under case.

## Mocks, Fakes, and Fixtures

Almost nothing is mocked. Queue, rate-limit, sweep and history checks run
against the real Neon database, create their own rows with a timestamped prefix,
and clean up in `after()`. The smoke suite discovers its fixtures from
`sitemap.xml` and the playback API rather than hardcoding slugs, so it works
against any deployment.

ES module exports are frozen — a function cannot be stubbed by assigning over
it. That is why `check-history.ts` tests the query layer directly instead of the
route handler.

## Known Flaky Tests

None. Two suites skip without infrastructure and say so:

- `check-analytics`, `check-token` — need a server on `CHECK_BASE_URL`
- `check-r2` — needs R2 credentials (ISSUE-001)
