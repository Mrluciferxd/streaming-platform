/**
 * Exercises the whole VideoProvider contract against a real R2 bucket.
 *
 *   npm run check:r2
 *
 * This is the first thing to run after provisioning the bucket. Everything up
 * to HLS packaging is verified locally by other checks, but the R2 leg —
 * multipart create/sign/list/complete, download, directory upload, public URL,
 * prefix delete — has only ever been typechecked. Typechecking does not catch a
 * wrong endpoint, a token without object-write permission, a bucket that is not
 * actually public, or an ETag round-trip that R2 rejects.
 *
 * It writes ~8 MB to the bucket under `_checks/` and `source/`, and deletes it
 * again. `_checks/` is deliberately outside `v/`, which is the prefix the
 * playback-gate Worker is routed on — a probe object must not be answered by
 * the gate instead of by the bucket.
 *
 * Skips cleanly when the credentials are absent or still placeholders.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type * as R2Module from '../src/lib/video/r2.ts'
import { MIN_PART_SIZE, paths, type UploadedPart } from '../src/lib/video/types.ts'
import { missingEnv, unmet } from './support.ts'

const REQUIRED = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
] as const

const missing = missingEnv(REQUIRED)
const reason =
  missing.length > 0
    ? `R2 is not configured — missing or placeholder: ${missing.join(', ')}`
    : null

/**
 * Imported directly rather than through `getVideoProvider()`, which is the one
 * place that is allowed to: the point of this file is to verify the R2
 * implementation itself, not whichever provider VIDEO_PROVIDER happens to name.
 * Anything that is not a check must go through the seam (src/lib/video/index.ts).
 */
const { r2Provider } = reason ? ({} as typeof R2Module) : await import('../src/lib/video/r2.ts')

const runId = randomUUID()
const videoId = randomUUID()
const probePrefix = `_checks/${runId}/`
const sourcePrefix = `source/${videoId}/`

// 8 MiB + 1 KiB: two parts, which is the only way to prove that part ordering,
// ETag round-tripping and the completion manifest actually work. A single-part
// upload would pass while all three were broken.
const lastPartBytes = 1024
const payload = randomBytes(MIN_PART_SIZE + lastPartBytes)
const payloadSha = sha256(payload)

let workDir = ''
let multipartId = ''
let objectKey = ''
let parts: UploadedPart[] = []
/** A second multipart, created solely to be abandoned. */
let doomed: { objectKey: string; multipartId: string } | null = null

function sha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** R2 quotes ETags; the SDK sometimes hands them back quoted, sometimes not. */
function unquote(etag: string): string {
  return etag.replace(/^"|"$/g, '')
}

describe('R2 provider contract', { skip: unmet(reason) }, () => {
  after(async () => {
    // Best effort: a failed assertion mid-run must still release anything that
    // would otherwise bill. Multipart parts are the expensive case — they are
    // invisible in a bucket listing.
    if (doomed) await r2Provider.abortResumableUpload(doomed).catch(() => {})
    if (multipartId && objectKey) {
      await r2Provider.abortResumableUpload({ objectKey, multipartId }).catch(() => {})
    }
    await r2Provider.deletePrefix(probePrefix).catch(() => {})
    await r2Provider.deletePrefix(sourcePrefix).catch(() => {})
    if (workDir) await rm(workDir, { recursive: true, force: true })
  })

  it('creates a multipart upload with a bucket-relative key', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'check-r2-'))

    const plan = await r2Provider.createResumableUpload({
      videoId,
      filename: 'check.mp4',
      contentType: 'video/mp4',
      sizeBytes: payload.byteLength,
    })

    assert.equal(plan.protocol, 'multipart', 'R2 must plan a multipart upload, never TUS')
    assert.equal(plan.objectKey, paths.source(videoId, 'mp4'), 'canonical object layout')
    assert.equal(plan.partSizeBytes, MIN_PART_SIZE)
    assert.equal(plan.totalParts, 2)
    assert.ok(plan.multipartId.length > 0, 'R2 returned an upload id')
    // No provider-shaped URL may reach the database (plan §2 migration rule).
    assert.ok(!plan.objectKey.includes('://'), 'the stored key is a path, not a URL')

    objectKey = plan.objectKey
    multipartId = plan.multipartId
  })

  it('presigns each part and R2 accepts a direct PUT', async () => {
    const uploaded: UploadedPart[] = []

    for (const partNumber of [1, 2]) {
      const url = await r2Provider.signUploadPart({ objectKey, multipartId, partNumber })
      assert.ok(url.startsWith('https://'), 'part URLs are https')
      assert.ok(
        url.includes('X-Amz-Signature'),
        'the part URL is presigned — the browser uploads without credentials',
      )

      const body =
        partNumber === 1
          ? payload.subarray(0, MIN_PART_SIZE)
          : payload.subarray(MIN_PART_SIZE)

      const res = await fetch(url, { method: 'PUT', body })
      assert.equal(res.status, 200, `part ${partNumber} PUT: ${res.status} ${await res.text()}`)

      const etag = res.headers.get('etag')
      assert.ok(etag, `part ${partNumber} returned no ETag`)
      uploaded.push({ partNumber, etag, sizeBytes: body.byteLength })
    }

    parts = uploaded
  })

  it('lists exactly the parts that landed — this is what makes resume work', async () => {
    const listed = await r2Provider.listUploadedParts({ objectKey, multipartId })

    assert.deepEqual(
      listed.map((p) => p.partNumber),
      [1, 2],
      'parts are returned in ascending order',
    )
    assert.equal(listed[0]!.sizeBytes, MIN_PART_SIZE)
    assert.equal(listed[1]!.sizeBytes, lastPartBytes)
    assert.deepEqual(
      listed.map((p) => unquote(p.etag)),
      parts.map((p) => unquote(p.etag)),
      'the listed ETags match what the PUTs returned',
    )
  })

  it('completes the upload and the object downloads back byte-identical', async () => {
    // Deliberately completing from the *listed* parts rather than the ones held
    // in memory: that is what a resumed upload does after a browser crash, and
    // it is the path that breaks if ETag quoting is mishandled.
    const listed = await r2Provider.listUploadedParts({ objectKey, multipartId })
    await r2Provider.completeResumableUpload({ objectKey, multipartId, parts: listed })
    multipartId = '' // completed; there is nothing left to abort.

    const localPath = path.join(workDir, 'downloaded.mp4')
    await r2Provider.downloadToFile(objectKey, localPath)

    assert.equal((await stat(localPath)).size, payload.byteLength)
    assert.equal(sha256(await readFile(localPath)), payloadSha, 'downloaded bytes differ')
  })

  it('uploads a directory tree, preserving relative paths', async () => {
    const packageDir = path.join(workDir, 'package')
    await mkdir(path.join(packageDir, '720p'), { recursive: true })
    await writeFile(path.join(packageDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n')
    await writeFile(path.join(packageDir, '720p', 'playlist.m3u8'), '#EXTM3U\n')
    await writeFile(path.join(packageDir, '720p', 'seg_00001.m4s'), randomBytes(2048))

    const count = await r2Provider.uploadDirectory({
      localDir: packageDir,
      keyPrefix: `${probePrefix}pkg`,
    })
    assert.equal(count, 3)

    const nested = await fetch(r2Provider.publicUrl(`${probePrefix}pkg/720p/playlist.m3u8`), {
      cache: 'no-store',
    })
    assert.equal(nested.status, 200, 'a nested file kept its relative path')
    // A playlist served as octet-stream makes Safari refuse the stream outright
    // rather than degrade, and nothing else in the pipeline would notice.
    assert.match(nested.headers.get('content-type') ?? '', /mpegurl/)
  })

  it('serves putObject content from the public base URL', async () => {
    const body = `check ${runId}`
    await r2Provider.putObject({
      path: `${probePrefix}probe.txt`,
      body,
      contentType: 'text/plain; charset=utf-8',
      cacheControl: 'no-store',
    })

    const url = r2Provider.publicUrl(`${probePrefix}probe.txt`)
    assert.ok(url.startsWith(publicBase()), 'publicUrl is built from R2_PUBLIC_BASE_URL')

    const res = await fetch(url, { cache: 'no-store' })
    assert.equal(
      res.status,
      200,
      `${url} returned ${res.status} — the bucket is not reachable at its public base URL. ` +
        'Bind the custom domain to the bucket and allow public reads; posters, ' +
        'sprites and playlists are all served from here.',
    )
    assert.equal(await res.text(), body)
  })

  it('abort releases the parts of an abandoned upload', async () => {
    // The property the sweeper cron depends on. Until an abort lands, uploaded
    // parts bill as storage while being invisible in the bucket listing, so a
    // silent no-op here would cost money indefinitely and show up nowhere.
    const plan = await r2Provider.createResumableUpload({
      videoId: randomUUID(),
      filename: 'abandoned.mp4',
      contentType: 'video/mp4',
      sizeBytes: MIN_PART_SIZE,
    })
    assert.equal(plan.protocol, 'multipart')

    doomed = { objectKey: plan.objectKey, multipartId: plan.multipartId }

    const url = await r2Provider.signUploadPart({ ...doomed, partNumber: 1 })
    const put = await fetch(url, { method: 'PUT', body: payload.subarray(0, MIN_PART_SIZE) })
    assert.equal(put.status, 200)
    assert.equal((await r2Provider.listUploadedParts(doomed)).length, 1)

    await r2Provider.abortResumableUpload(doomed)

    await assert.rejects(
      () => r2Provider.listUploadedParts(doomed!),
      'the upload is gone, not merely emptied',
    )
    doomed = null
  })

  it('deletePrefix removes every object under the prefix', async () => {
    await r2Provider.deletePrefix(probePrefix)

    await assert.rejects(
      () => r2Provider.downloadToFile(`${probePrefix}probe.txt`, path.join(workDir, 'gone.txt')),
      'the deleted object is really gone',
    )

    const res = await fetch(r2Provider.publicUrl(`${probePrefix}pkg/master.m3u8`), {
      cache: 'no-store',
    })
    assert.ok(res.status === 404 || res.status === 403, `expected 404/403, got ${res.status}`)
  })
})

function publicBase(): string {
  return (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '') + '/'
}
