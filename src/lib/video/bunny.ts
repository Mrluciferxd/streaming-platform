import { env } from '@/lib/env'
import type {
  PlaybackSource,
  ResumableUploadPlan,
  UploadTicket,
  VideoProvider,
} from './types'

/**
 * Bunny Stream. Managed upload → transcode → delivery → player.
 *
 * Kept as a working second implementation so the plan §2 escape hatch stays
 * real: if the self-hosted FFmpeg pipeline turns into a time sink, flipping
 * VIDEO_PROVIDER=bunny moves the whole video layer to a managed service without
 * touching anything outside this directory.
 *
 * Bunny owns the object layout, so the bucket-relative paths used by the R2
 * provider don't apply. `videos.provider_asset_id` holds Bunny's GUID and
 * `videos.hls_master_path` is ignored for these rows.
 */

const libraryId = env.BUNNY_LIBRARY_ID!
const apiKey = env.BUNNY_API_KEY!
const cdnHost = env.BUNNY_CDN_HOSTNAME!

const API = 'https://video.bunnycdn.com'

async function bunnyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { AccessKey: apiKey, 'Content-Type': 'application/json', ...init.headers },
  })

  if (!res.ok) {
    throw new Error(`Bunny ${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`)
  }
  return res
}

export const bunnyProvider: VideoProvider = {
  id: 'bunny',

  async createUploadTicket({ filename }): Promise<UploadTicket> {
    // Two steps: create the video record, then hand back a direct PUT URL.
    // Bunny also speaks TUS at https://video.bunnycdn.com/tusupload, which is
    // the resumable path to switch to for large creator uploads (plan §5.1).
    const created = (await (
      await bunnyFetch(`/library/${libraryId}/videos`, {
        method: 'POST',
        body: JSON.stringify({ title: filename }),
      })
    ).json()) as { guid: string }

    return {
      url: `${API}/library/${libraryId}/videos/${created.guid}`,
      method: 'PUT',
      headers: { AccessKey: apiKey },
      assetId: created.guid,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    }
  },

  async getPlaybackSource({ videoId, hlsMasterPath }): Promise<PlaybackSource> {
    // For Bunny rows the caller passes the GUID through as hlsMasterPath.
    const guid = hlsMasterPath ?? videoId
    const base = `https://${cdnHost}/${guid}`

    return {
      masterUrl: `${base}/playlist.m3u8`,
      posterUrl: `${base}/thumbnail.jpg`,
      // Bunny generates its own seek preview sheet.
      spriteUrl: `${base}/preview.webp`,
      spriteVttUrl: `${base}/seek/seek.vtt`,
    }
  },

  publicUrl(path) {
    return `https://${cdnHost}/${path.replace(/^\/+/, '')}`
  },

  // --- Resumable upload ------------------------------------------------------

  async createResumableUpload({ filename }): Promise<ResumableUploadPlan> {
    const created = (await (
      await bunnyFetch(`/library/${libraryId}/videos`, {
        method: 'POST',
        body: JSON.stringify({ title: filename }),
      })
    ).json()) as { guid: string }

    // Bunny speaks TUS natively, which is what plan §5.1 actually asked for.
    return {
      protocol: 'tus',
      endpoint: `${API}/tusupload`,
      headers: {
        AuthorizationSignature: '', // caller computes: sha256(libraryId + apiKey + expiry + videoId)
        AuthorizationExpire: '',
        VideoId: created.guid,
        LibraryId: libraryId,
      },
      assetId: created.guid,
    }
  },

  async signUploadPart() {
    throw new Error(
      'bunnyProvider.signUploadPart: TUS resumes client-side by asking the ' +
        'upload URL its current offset. There are no server-signed parts.',
    )
  },

  async listUploadedParts() {
    throw new Error(
      'bunnyProvider.listUploadedParts: TUS tracks offset via a HEAD on the ' +
        'upload URL, not a server-side part list.',
    )
  },

  async completeResumableUpload() {
    // TUS finalises when the last chunk lands; nothing to do server-side.
  },

  async abortResumableUpload({ objectKey }) {
    const guid = objectKey.replace(/^v\//, '').replace(/\/$/, '')
    await bunnyFetch(`/library/${libraryId}/videos/${guid}`, { method: 'DELETE' })
  },

  // --- Worker-side transfer --------------------------------------------------

  async downloadToFile() {
    throw new Error(
      'bunnyProvider.downloadToFile: Bunny transcodes server-side, so there is ' +
        'no local transcode step and no source to fetch.',
    )
  },

  async uploadDirectory() {
    throw new Error(
      'bunnyProvider.uploadDirectory: Bunny produces and hosts its own HLS ' +
        'package. Nothing is uploaded to it.',
    )
  },

  async putObject() {
    throw new Error(
      'bunnyProvider.putObject: Bunny Stream owns its object layout. ' +
        'Generated artifacts (playlists, sprites) are produced by Bunny, not uploaded.',
    )
  },

  async deletePrefix(prefix) {
    // `prefix` carries the video GUID for Bunny-backed rows.
    const guid = prefix.replace(/^v\//, '').replace(/\/$/, '')
    await bunnyFetch(`/library/${libraryId}/videos/${guid}`, { method: 'DELETE' })
  },
}
