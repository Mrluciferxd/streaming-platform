import { createWriteStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { env } from '@/lib/env'
import {
  paths,
  planPartSize,
  type PlaybackSource,
  type ResumableUploadPlan,
  type UploadedPart,
  type UploadTicket,
  type VideoProvider,
} from './types'

/**
 * Cloudflare R2. Zero egress at any volume (plan §0), S3-compatible API.
 *
 * Confirmed policy note: Cloudflare removed the old Section 2.8 restriction on
 * serving video through their CDN, and now explicitly permits it when the
 * content is hosted in a Cloudflare service — R2 included. Serving video from
 * an origin *outside* Cloudflare is still restricted, so the bucket must stay
 * the origin.
 */

const accountId = env.R2_ACCOUNT_ID!
const bucket = env.R2_BUCKET!
const publicBase = env.R2_PUBLIC_BASE_URL!.replace(/\/+$/, '')

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
  },
})

/**
 * Cache-Control is a direct cost lever, not a detail. Every second a segment
 * stays in the edge cache is a Class B read against R2 that never happens.
 * VOD segments and playlists are immutable once published — a re-encode writes
 * to a new video id — so they get a one-year TTL.
 */
const CACHE = {
  immutable: 'public, max-age=31536000, immutable',
  // Only used for assets that can be replaced in place, e.g. a re-cut poster.
  mutable: 'public, max-age=300, stale-while-revalidate=86400',
} as const

const UPLOAD_TICKET_TTL_SEC = 3600

export const r2Provider: VideoProvider = {
  id: 'r2',

  async createUploadTicket({ videoId, filename, contentType }): Promise<UploadTicket> {
    const ext = filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4'
    const key = paths.source(videoId, ext)

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_TICKET_TTL_SEC },
    )

    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      assetId: key,
      expiresAt: new Date(Date.now() + UPLOAD_TICKET_TTL_SEC * 1000),
    }
  },

  async getPlaybackSource({
    hlsMasterPath,
    posterPath,
    spritePath,
    spriteVttPath,
  }): Promise<PlaybackSource> {
    /**
     * Note what is deliberately absent: no per-request signing of these URLs.
     * They are stable and identical for every viewer, which is what keeps the
     * CDN cache hit ratio high. Authorisation rides on the `pb` cookie checked
     * at the edge — see ./token.ts.
     */
    return {
      masterUrl: hlsMasterPath ? publicUrl(hlsMasterPath) : '',
      posterUrl: posterPath ? publicUrl(posterPath) : null,
      spriteUrl: spritePath ? publicUrl(spritePath) : null,
      spriteVttUrl: spriteVttPath ? publicUrl(spriteVttPath) : null,
    }
  },

  publicUrl,

  // --- Resumable upload ------------------------------------------------------

  async createResumableUpload({ videoId, filename, contentType, sizeBytes }): Promise<ResumableUploadPlan> {
    const ext = extensionOf(filename)
    const objectKey = paths.source(videoId, ext)
    const { partSizeBytes, totalParts } = planPartSize(sizeBytes)

    const created = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: contentType,
      }),
    )

    if (!created.UploadId) {
      throw new Error('R2 did not return an UploadId for the multipart upload.')
    }

    return {
      protocol: 'multipart',
      objectKey,
      multipartId: created.UploadId,
      partSizeBytes,
      totalParts,
    }
  },

  async signUploadPart({ objectKey, multipartId, partNumber }) {
    return getSignedUrl(
      s3,
      new UploadPartCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: multipartId,
        PartNumber: partNumber,
      }),
      { expiresIn: UPLOAD_TICKET_TTL_SEC },
    )
  },

  async listUploadedParts({ objectKey, multipartId }): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = []
    let marker: number | undefined

    do {
      const page = await s3.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: objectKey,
          UploadId: multipartId,
          PartNumberMarker: marker === undefined ? undefined : String(marker),
        }),
      )

      for (const p of page.Parts ?? []) {
        if (p.PartNumber && p.ETag) {
          parts.push({ partNumber: p.PartNumber, etag: p.ETag, sizeBytes: p.Size ?? 0 })
        }
      }

      marker = page.IsTruncated ? Number(page.NextPartNumberMarker) : undefined
    } while (marker !== undefined)

    return parts.sort((a, b) => a.partNumber - b.partNumber)
  },

  async completeResumableUpload({ objectKey, multipartId, parts }) {
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: multipartId,
        MultipartUpload: {
          // S3 rejects an out-of-order part list outright.
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    )
  },

  async abortResumableUpload({ objectKey, multipartId }) {
    // Until this runs, the parts already uploaded keep billing as storage.
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: multipartId,
      }),
    )
  },

  // --- Worker-side transfer --------------------------------------------------

  async downloadToFile(objectKey, localPath) {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }))
    if (!res.Body) throw new Error(`R2 object ${objectKey} has no body.`)

    // Streamed, not buffered: source files run to gigabytes and a worker VPS
    // has ~8 GB of RAM.
    await pipeline(res.Body as Readable, createWriteStream(localPath))
  },

  async uploadDirectory({ localDir, keyPrefix, onProgress }) {
    const files = await walk(localDir)
    let done = 0

    // Bounded concurrency: enough to saturate the link, not enough to make R2
    // start returning 503s on a big ladder.
    const CONCURRENCY = 8
    const queue = [...files]

    async function drain() {
      for (;;) {
        const file = queue.shift()
        if (!file) return

        const relative = path.relative(localDir, file).split(path.sep).join('/')
        const key = `${keyPrefix.replace(/\/+$/, '')}/${relative}`

        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: await readFileBuffer(file),
            ContentType: contentTypeFor(file),
            CacheControl: CACHE.immutable,
          }),
        )

        onProgress?.(++done, files.length)
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, drain))
    return files.length
  },

  async putObject({ path, body, contentType, cacheControl }) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: path,
        Body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
        ContentType: contentType,
        CacheControl: cacheControl ?? CACHE.immutable,
      }),
    )
  },

  async deletePrefix(prefix) {
    let continuationToken: string | undefined

    do {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )

      const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []))
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
        )
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
    } while (continuationToken)
  },
}

function publicUrl(path: string): string {
  return `${publicBase}/${path.replace(/^\/+/, '')}`
}

function extensionOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4'
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }

  return out
}

async function readFileBuffer(file: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  const size = (await stat(file)).size

  // HLS artefacts are segments and playlists — a few MB at most. Anything
  // larger has no business in this path and buffering it would be a bug.
  if (size > 64 * 1024 * 1024) {
    throw new Error(`Refusing to buffer ${file} (${size} bytes) — use multipart upload instead.`)
  }

  return readFile(file)
}

/**
 * Content types matter more than usual here. A segment served as
 * application/octet-stream still plays, but `.m3u8` served with the wrong type
 * makes Safari refuse the stream, and a missing type on `.vtt` breaks scrub
 * previews silently.
 */
function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase()

  switch (ext) {
    case '.m3u8':
      return 'application/vnd.apple.mpegurl'
    case '.m4s':
    case '.mp4':
      return 'video/mp4'
    case '.vtt':
      return 'text/vtt'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.png':
      return 'image/png'
    default:
      return 'application/octet-stream'
  }
}

export { CACHE as r2CacheControl }
