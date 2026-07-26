/**
 * The abandoned-upload sweeper, against a real Postgres.
 *
 *   npm run check:sweep
 *
 * This is the one scheduled job whose failure costs money rather than accuracy.
 * An S3 multipart upload whose client vanished keeps the parts already sent,
 * those parts bill as storage, and they do not appear in a bucket listing — so
 * a sweeper that silently stops aborting them produces a bill nobody can
 * explain from the console. Worth a test that actually watches an expired
 * upload get released.
 *
 * The route handler is invoked directly rather than over HTTP, so this needs no
 * server. Writes and deletes rows in `videos` and `uploads`, so point it at
 * development.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import type * as DbModule from '../src/db/index.ts'
import type * as SweepModule from '../src/app/api/cron/sweep/route.ts'
import { unmet } from './support.ts'

const skip = unmet(
  !process.env.DATABASE_URL
    ? 'DATABASE_URL is not set'
    : !process.env.CRON_SECRET
      ? 'CRON_SECRET is not set'
      : null,
)

const { db, sqlClient, uploads, videos } = skip
  ? ({} as typeof DbModule)
  : await import('../src/db/index.ts')
const { GET } = skip ? ({} as typeof SweepModule) : await import('../src/app/api/cron/sweep/route.ts')

const created: { videoId: string; uploadId: string }[] = []

function sweep(authorization?: string): Promise<Response> {
  return GET(
    new Request('http://check/api/cron/sweep', {
      headers: authorization ? { authorization } : {},
    }),
  )
}

/** An upload whose 24-hour window closed an hour ago, with its video still mid-upload. */
async function abandonedUpload() {
  const [video] = await db
    .insert(videos)
    .values({
      slug: `check-sweep-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Sweeper check',
      status: 'uploading',
      provider: 'local',
    })
    .returning({ id: videos.id })

  const [upload] = await db
    .insert(uploads)
    .values({
      videoId: video!.id,
      objectKey: `source/${video!.id}/original.mp4`,
      multipartId: `check-sweep-${crypto.randomUUID()}`,
      partSizeBytes: 8 * 1024 * 1024,
      totalBytes: 8 * 1024 * 1024 + 1,
      totalParts: 2,
      filename: 'check.mp4',
      contentType: 'video/mp4',
      expiresAt: new Date(Date.now() - 3_600_000),
    })
    .returning({ id: uploads.id })

  created.push({ videoId: video!.id, uploadId: upload!.id })
  return { videoId: video!.id, uploadId: upload!.id }
}

describe('sweep cron', { skip }, () => {
  after(async () => {
    for (const { videoId, uploadId } of created) {
      await db.delete(uploads).where(eq(uploads.id, uploadId))
      await db.delete(videos).where(eq(videos.id, videoId))
    }
    await sqlClient.end()
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await sweep()
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error, 'unauthorised')
  })

  it('refuses a wrong bearer token', async () => {
    assert.equal((await sweep('Bearer not-the-cron-secret')).status, 401)
    // A prefix of the real secret must not pass either — the comparison is
    // constant-time over equal lengths, not a startsWith.
    assert.equal((await sweep(`Bearer ${process.env.CRON_SECRET!.slice(0, -1)}`)).status, 401)
  })

  it('aborts an expired upload and frees the video it stranded', async () => {
    const { videoId, uploadId } = await abandonedUpload()

    const res = await sweep(`Bearer ${process.env.CRON_SECRET}`)
    assert.equal(res.status, 200)

    const body = (await res.json()) as {
      ok: boolean
      errors: string[]
      uploads: { found: number; aborted: number; failed: number }
    }
    assert.equal(body.ok, true, body.errors.join('; '))
    assert.ok(body.uploads.found >= 1, 'the expired upload was not found')
    assert.equal(body.uploads.failed, 0)

    const [upload] = await db.select().from(uploads).where(eq(uploads.id, uploadId))
    assert.equal(upload!.status, 'aborted', 'the parts were never released')

    // Left in `uploading` the video row holds its slug and the partial unique
    // index that stops a second upload against it, forever.
    const [video] = await db.select().from(videos).where(eq(videos.id, videoId))
    assert.equal(video!.status, 'failed')
  })

  it('leaves an upload that has not expired alone', async () => {
    const { uploadId } = await abandonedUpload()
    await db
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(uploads.id, uploadId))

    await sweep(`Bearer ${process.env.CRON_SECRET}`)

    const [upload] = await db.select().from(uploads).where(eq(uploads.id, uploadId))
    assert.equal(upload!.status, 'pending', 'the sweeper aborted an upload still in flight')
  })

  it('reports every step it ran, so a broken one is visible', async () => {
    const res = await sweep(`Bearer ${process.env.CRON_SECRET}`)
    const body = (await res.json()) as Record<string, unknown>

    for (const step of [
      'uploads',
      'sessionsPurged',
      'rateLimitRowsPurged',
      'jobsRequeued',
      'doneJobsPurged',
      'deadJobsPurged',
    ]) {
      assert.ok(step in body, `${step} is missing from the run report`)
    }
    assert.deepEqual(body.errors, [])
  })
})
