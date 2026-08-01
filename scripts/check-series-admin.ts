/**
 * Series & episodes admin layer, against a real Postgres.
 *
 *   npm run check:series-admin
 *
 * Exists for the same reason check-history does: the admin API writes raw SQL
 * through Drizzle, and a query that typechecks and a query that runs are two
 * different things (ISSUE-002 fixed a 500 that shipped through 69 green tests
 * because no test executed the query). The series/episodes admin surface is
 * brand new and entirely query-layer, so this is the gate that proves it.
 *
 * Invokes the queries directly, not the route handlers — see check-history for
 * the same reasoning. Writes and deletes rows in `series`, `episodes`, `videos`
 * and `audit_log`, so point it at a development database.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { eq, inArray, sql } from 'drizzle-orm'

import type * as DbModule from '../src/db/index.ts'
import type * as AdminModule from '../src/lib/queries/admin.ts'
import { unmet } from './support.ts'

const skip = unmet(process.env.DATABASE_URL ? null : 'DATABASE_URL is not set')

/**
 * Imported only when the suite will actually run. `src/db` validates the entire
 * environment at module load, so importing it with no database configured
 * would throw before the runner ever reported a skip.
 */
const { db, series, episodes, videos, auditLog, sqlClient } = skip
  ? ({} as typeof DbModule)
  : await import('../src/db/index.ts')
const {
  createAdminSeries,
  deleteAdminSeries,
  getAdminSeries,
  getEpisodeForVideo,
  listAdminSeries,
  listAdminEpisodes,
  listEpisodeCandidates,
  attachEpisode,
  updateEpisode,
  detachEpisode,
  recordAudit,
} = skip ? ({} as typeof AdminModule) : await import('../src/lib/queries/admin.ts')

/** Namespaces every fixture slug so concurrent runs and a crashed run can
 * both be cleaned by a `slug like '<tag>%'` sweep without touching real rows. */
  const tag = `check-series-${Date.now()}`
  // `recordAudit` accepts `actorId: null` — that is how cron-scheduled publishes
  // record their own audit rows ("system" appears as the actor on the audit
  // page). Using null here keeps the test free of a fixture user, AND verifies
  // the contract that a no-actor audit row is legal (an FK violation would
  // surface if anyone ever wired actorId as NOT NULL -- they didn't, but the
  // audit trail for a cron job would silently break the moment someone tries).

const cleanupSeriesIds: string[] = []
const cleanupVideoIds: string[] = []

/** Shared across it()s because creating a series is the precondition for every
 * episode assertion, and re-creating it per case would couple them anyway. */
let seriesId = ''
let videoId = ''
let videoId2 = ''
let videoIdOnOtherSeries = ''

describe('series & episodes admin', { skip }, async () => {
  after(async () => {
    // Order matters: episodes cascade off series, but videos rows survive
    // because a series going away is reversible — so videos are cleaned
    // independently. Audit rows reference both; deleting either entity first
    // is fine because audit_log has no FK to them (it is append-only).
    if (cleanupSeriesIds.length) {
      await db.delete(series).where(inArray(series.id, cleanupSeriesIds))
    }
    if (cleanupVideoIds.length) {
      await db.delete(videos).where(inArray(videos.id, cleanupVideoIds))
    }
    // Anything this run left behind in case of an early throw.
    await db.delete(series).where(sql`${series.slug} like ${`${tag}-%`}`)

    // Audit rows: also keyed by tag-carrying slugs would be ideal, but
    // audit_log carries no slug field — and the rows reference synthetic ids
    // that no longer exist. A wider cleanup by actor keeps the trail honest
    // while making sure no fixture audit row survives collect-dust.
    if (cleanupSeriesIds.length) {
      await db
        .delete(auditLog)
        .where(
          sql`${auditLog.entityType} = 'series' AND ${auditLog.entityId} in (${sql.join(
            cleanupSeriesIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        )
    }

    await sqlClient.end()
  })

  // --- create + list --------------------------------------------------------
  it('createAdminSeries returns a series row, and listAdminSeries finds it', async () => {
    const created = await createAdminSeries({
      slug: `${tag}-alpha`,
      title: 'Check Alpha',
      status: 'airing',
      totalEpisodes: 12,
      releaseYear: 2026,
      seasonLabel: 'Spring 2026',
      studio: 'Studio Check',
    })
    cleanupSeriesIds.push(created.id)
    seriesId = created.id

    const detail = await getAdminSeries(seriesId)
    assert.ok(detail, 'getAdminSeries returns the row just created')
    assert.equal(detail!.slug, `${tag}-alpha`)
    assert.equal(detail!.title, 'Check Alpha')
    assert.equal(detail!.totalEpisodes, 12)

    const listed = await listAdminSeries()
    const ours = listed.find((row) => row.id === seriesId)
    assert.ok(ours, 'listAdminSeries includes the row just created')
    assert.equal(ours!.status, 'airing')
    assert.equal(ours!.totalEpisodes, 12)
  })

  it('createAdminSeries rejects a duplicate slug with isUniqueViolation on the caller', async () => {
    let threw: unknown = null
    try {
      await createAdminSeries({ slug: `${tag}-alpha`, title: 'Collision' })
    } catch (error) {
      // No catch here — the throw is the test. Re-thrown below if it doesn't match.
      threw = error
    }
    assert.ok(threw, 'inserting a duplicate slug throws')
    // Walk the cause chain the way isUniqueViolation does, but inline: this
    // keeps the assertion local to the query-layer contract.
    let walker: unknown = threw
    let found = false
    for (let depth = 0; walker && depth < 5; depth++) {
      const w = walker as { code?: unknown; constraint_name?: unknown; cause?: unknown }
      if (w.code === '23505' && w.constraint_name === 'series_slug_key') {
        found = true
        break
      }
      walker = w.cause
    }
    assert.ok(found, `threw, but not a series_slug_key violation: ${String(threw)}`)
  })

  // --- episode rows ---------------------------------------------------------
  it('attachEpisode places a video at a (season, episode) slot', async () => {
    videoId = await makeVideo(`ep1`)
    cleanupVideoIds.push(videoId)

    await attachEpisode({ seriesId, videoId, seasonNo: 1, episodeNo: 1 })
    const eps = await listAdminEpisodes(seriesId)
    assert.equal(eps.length, 1)
    assert.equal(eps[0]!.videoId, videoId)
    assert.equal(eps[0]!.seasonNo, 1)
    assert.equal(eps[0]!.episodeNo, 1)

    const ctx = await getEpisodeForVideo(videoId)
    assert.ok(ctx, 'getEpisodeForVideo resolves the episode back to its series')
    assert.equal(ctx!.seriesId, seriesId)
    assert.equal(ctx!.seasonNo, 1)
    assert.equal(ctx!.episodeNo, 1)
  })

  it('attachEpisode on a taken (season, episode) slot trips episodes_series_season_ep_key', async () => {
    videoId2 = await makeVideo('ep1b')
    cleanupVideoIds.push(videoId2)

    let threw: unknown = null
    try {
      await attachEpisode({ seriesId, videoId: videoId2, seasonNo: 1, episodeNo: 1 })
    } catch (error) {
      threw = error
    }
    assert.ok(threw, 'attaching to a used slot throws')
    let walker: unknown = threw
    let found = false
    for (let depth = 0; walker && depth < 5; depth++) {
      const w = walker as { code?: unknown; constraint_name?: unknown; cause?: unknown }
      if (w.code === '23505' && w.constraint_name === 'episodes_series_season_ep_key') {
        found = true
        break
      }
      walker = w.cause
    }
    assert.ok(
      found,
      `threw, but not episodes_series_season_ep_key: ${String(threw)} — ` +
        'a different constraint means the schema drifted from the unique index this surface relies on',
    )
  })

  it('a video belongs to at most one series (episodes_video_key)', async () => {
    // Stand up a second series, then try to attach the same video to it.
    const second = await createAdminSeries({ slug: `${tag}-beta`, title: 'Check Beta' })
    cleanupSeriesIds.push(second.id)

    let threw: unknown = null
    try {
      await attachEpisode({
        seriesId: second.id,
        videoId, // already on `seriesId` from the previous test
        seasonNo: 1,
        episodeNo: 1,
      })
    } catch (error) {
      threw = error
    }
    assert.ok(threw, 'attaching a video to a second series throws')
    let walker: unknown = threw
    let found = false
    for (let depth = 0; walker && depth < 5; depth++) {
      const w = walker as { code?: unknown; constraint_name?: unknown; cause?: unknown }
      if (w.code === '23505' && w.constraint_name === 'episodes_video_key') {
        found = true
        break
      }
      walker = w.cause
    }
    assert.ok(found, `threw, but not episodes_video_key: ${String(threw)}`)

    // `videoId2` was *not* attached (previous test's slot collision prevented
    // it), so it can be attached to this second series. We reuse that below
    // to assert that the picker excludes it from the first series' candidates.
    await attachEpisode({ seriesId: second.id, videoId: videoId2, seasonNo: 1, episodeNo: 1 })
    videoIdOnOtherSeries = videoId2
  })

  it('listEpisodeCandidates excludes videos already on this series and flags others', async () => {
    // A standalone video never seen by the series; should appear, no attached series.
    const standalone = await makeVideo('standalone')
    cleanupVideoIds.push(standalone)

    const candidates = await listEpisodeCandidates(seriesId)
    const standaloneRow = candidates.find((c) => c.id === standalone)
    assert.ok(standaloneRow, 'a standalone video is a candidate for any series')
    assert.equal(standaloneRow!.attachedSeriesId, null)

    // The video already on THIS series is excluded outright.
    const thisSeriesVideo = candidates.find((c) => c.id === videoId)
    assert.equal(thisSeriesVideo, undefined, 'a video already on this series is not a candidate')

    // A video on ANOTHER series shows up but flags its attachment.
    const otherSeriesVideo = candidates.find((c) => c.id === videoIdOnOtherSeries)
    assert.ok(otherSeriesVideo, 'a video on another series appears with its attachment flagged')
    assert.notEqual(otherSeriesVideo!.attachedSeriesId, null)
    assert.notEqual(otherSeriesVideo!.attachedSeriesTitle, null)
  })

  it('updateEpisode moves an episode to a new (season, episode) slot', async () => {
    // The video currently sits at S1·E1 of the first series.
    const [ep] = await db
      .select({ id: episodes.id })
      .from(episodes)
      .where(eq(episodes.videoId, videoId))
      .limit(1)
    assert.ok(ep, 'expected an episode row for the fixture video')

    await updateEpisode(ep!.id, { seasonNo: 2, episodeNo: 4, title: 'Relocated' })

    const ctx = await getEpisodeForVideo(videoId)
    assert.equal(ctx!.seasonNo, 2)
    assert.equal(ctx!.episodeNo, 4)

    const [row] = await db
      .select({ title: episodes.title })
      .from(episodes)
      .where(eq(episodes.id, ep!.id))
      .limit(1)
    assert.equal(row!.title, 'Relocated')
  })

  it('detachEpisode removes the join row but leaves the video row', async () => {
    await detachEpisode(
      (
        await db
          .select({ id: episodes.id })
          .from(episodes)
          .where(eq(episodes.videoId, videoId))
          .limit(1)
      )[0]!.id,
    )

    const ctx = await getEpisodeForVideo(videoId)
    assert.equal(ctx, null, 'a detached video has no series context')

    const [videoRow] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1)
    assert.ok(videoRow, 'the video row survives detach — media, history and revenue stay')

    const eps = await listAdminEpisodes(seriesId)
    assert.equal(eps.length, 0, 'the series has no episodes after the only one is detached')
  })

  it('deleteAdminSeries cascade-removes episodes but leaves videos', async () => {
    // Re-attach so the cascade has something to remove.
    await attachEpisode({ seriesId, videoId, seasonNo: 1, episodeNo: 1 })

    const { episodeCount } = await deleteAdminSeries(seriesId)
    assert.ok(episodeCount >= 1, 'cascade reports the removed episode rows')

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId)).limit(1)
    assert.equal(seriesRow, undefined, 'the series row is gone')

    const [videoRow] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1)
    assert.ok(videoRow, 'the video row survives series deletion')

    const ctx = await getEpisodeForVideo(videoId)
    assert.equal(ctx, null, 'cascade removed the episode row, so the video is standalone again')

    // Pull the id out of cleanup — deleting twice would throw.
    const i = cleanupSeriesIds.indexOf(seriesId)
    if (i >= 0) cleanupSeriesIds.splice(i, 1)
  })

  it('recordAudit writes a row the operator-surface audit query can read back', async () => {
    // Make a fresh series so the audit target exists.
    const fresh = await createAdminSeries({ slug: `${tag}-audit`, title: 'Audit Target' })
    cleanupSeriesIds.push(fresh.id)

    await recordAudit({
      actorId: null,
      action: 'series.update',
      entityType: 'series',
      entityId: fresh.id,
      before: { title: 'Audit Target' },
      after: { title: 'Audit Target (renamed)' },
    })

    const [row] = await db
      .select({ action: auditLog.action, entityType: auditLog.entityType, entityId: auditLog.entityId })
      .from(auditLog)
      .where(eq(auditLog.entityId, fresh.id))
      .limit(1)

    assert.equal(row!.action, 'series.update')
    assert.equal(row!.entityType, 'series')
    assert.equal(row!.entityId, fresh.id)
  })

  /** Helper: a fixture video with the bare minimum needed to be a legal episode. */
  async function makeVideo(label: string): Promise<string> {
    const [row] = await db
      .insert(videos)
      .values({
        slug: `${tag}-${label}-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
        title: `Check ${label}`,
        status: 'ready', // 'ready', not 'published': operators can line up episodes before going live
      })
      .returning({ id: videos.id })
    return row!.id
  }
})
