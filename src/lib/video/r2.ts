import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { env } from '@/lib/env'
import { paths, type PlaybackSource, type UploadTicket, type VideoProvider } from './types'

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

export { CACHE as r2CacheControl }
