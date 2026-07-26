import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

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
 * Filesystem provider — development only.
 *
 * Writes the HLS package into `public/media/` so the Next.js dev server serves
 * it, which makes the player, the pages, and the whole watch path testable with
 * no Cloudflare account and no credentials. Without it there is nothing to play
 * locally and the front end can only be checked against a stub.
 *
 * It is not a deployment target: no CDN, no cache headers, no signed access, and
 * every byte is served by the application process — precisely the thing plan §3
 * says must never happen. `src/lib/env.ts` refuses to select it in production.
 */

const MEDIA_ROOT = path.join(process.cwd(), 'public', 'media')
const PUBLIC_PREFIX = '/media'

export const localProvider: VideoProvider = {
  id: 'local',

  async createUploadTicket({ videoId, filename }): Promise<UploadTicket> {
    const ext = filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4'
    const key = paths.source(videoId, ext)

    return {
      url: `${PUBLIC_PREFIX}/${key}`,
      method: 'PUT',
      assetId: key,
      expiresAt: new Date(Date.now() + 3600_000),
    }
  },

  async getPlaybackSource({
    hlsMasterPath,
    posterPath,
    spritePath,
    spriteVttPath,
  }): Promise<PlaybackSource> {
    return {
      masterUrl: hlsMasterPath ? publicUrl(hlsMasterPath) : '',
      posterUrl: posterPath ? publicUrl(posterPath) : null,
      spriteUrl: spritePath ? publicUrl(spritePath) : null,
      spriteVttUrl: spriteVttPath ? publicUrl(spriteVttPath) : null,
    }
  },

  publicUrl,

  async createResumableUpload({ videoId, filename, sizeBytes }): Promise<ResumableUploadPlan> {
    const ext = filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4'
    const objectKey = paths.source(videoId, ext)
    const { partSizeBytes, totalParts } = planPartSize(sizeBytes)

    await mkdir(path.dirname(path.join(MEDIA_ROOT, objectKey)), { recursive: true })

    return { protocol: 'multipart', objectKey, multipartId: 'local', partSizeBytes, totalParts }
  },

  async signUploadPart({ objectKey, partNumber }) {
    return `${PUBLIC_PREFIX}/${objectKey}.part${partNumber}`
  },

  async listUploadedParts(): Promise<UploadedPart[]> {
    // Resume is meaningless against a local disk; scripts/seed-video.ts places
    // files directly rather than going through the upload API.
    return []
  },

  async completeResumableUpload() {},

  async abortResumableUpload({ objectKey }) {
    await rm(path.join(MEDIA_ROOT, objectKey), { force: true })
  },

  async downloadToFile(objectKey, localPath) {
    await copyFile(path.join(MEDIA_ROOT, objectKey), localPath)
  },

  async uploadDirectory({ localDir, keyPrefix, onProgress }) {
    const files = await walk(localDir)

    for (const [i, file] of files.entries()) {
      const relative = path.relative(localDir, file).split(path.sep).join('/')
      const target = path.join(MEDIA_ROOT, keyPrefix.replace(/\/+$/, ''), relative)

      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(file, target)
      onProgress?.(i + 1, files.length)
    }

    return files.length
  },

  async putObject({ path: key, body }) {
    const target = path.join(MEDIA_ROOT, key)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
  },

  async deletePrefix(prefix) {
    await rm(path.join(MEDIA_ROOT, prefix), { recursive: true, force: true })
  },
}

function publicUrl(key: string): string {
  return `${PUBLIC_PREFIX}/${key.replace(/^\/+/, '')}`
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

export async function localMediaSize(): Promise<number> {
  try {
    const files = await walk(MEDIA_ROOT)
    let total = 0
    for (const f of files) total += (await stat(f)).size
    return total
  } catch {
    return 0
  }
}
