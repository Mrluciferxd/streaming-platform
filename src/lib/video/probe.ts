import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe'
export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg'

export type ProbeResult = {
  durationSec: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string | null
  hasAudio: boolean
  bitrateKbps: number
  sizeBytes: number
  /** Rotation from container metadata; 90/270 mean display dimensions swap. */
  rotation: number
}

type FfprobeStream = {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  side_data_list?: { rotation?: number }[]
  tags?: { rotate?: string }
}

type FfprobeOutput = {
  streams?: FfprobeStream[]
  format?: { duration?: string; size?: string; bit_rate?: string }
}

/** "30000/1001" → 29.97. Returns 0 for the "0/0" ffprobe emits on odd inputs. */
function parseFrameRate(value: string | undefined): number {
  if (!value) return 0
  const [num, den] = value.split('/').map(Number)
  if (!num || !den) return 0
  return num / den
}

export class ProbeError extends Error {}

/**
 * Read technical metadata and reject unusable files early (plan §5.2).
 *
 * Doing this before the job is enqueued means a corrupt upload fails in
 * milliseconds with a message a creator can act on, rather than after ten
 * minutes of transcoding.
 */
export async function probe(filePath: string): Promise<ProbeResult> {
  let stdout: string
  try {
    ;({ stdout } = await run(
      FFPROBE,
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    ))
  } catch (error) {
    throw new ProbeError(
      `Not a readable media file: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const parsed = JSON.parse(stdout) as FfprobeOutput
  const video = parsed.streams?.find((s) => s.codec_type === 'video')
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio')

  if (!video || !video.width || !video.height) {
    throw new ProbeError('File contains no decodable video stream.')
  }

  const durationSec = Number(parsed.format?.duration ?? 0)
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ProbeError('File has no usable duration; it is likely truncated.')
  }

  const rotationRaw =
    video.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation ??
    Number(video.tags?.rotate ?? 0)
  const rotation = ((Math.round(rotationRaw) % 360) + 360) % 360

  // A phone-shot portrait video reports landscape dimensions plus a rotation
  // flag. Ladder selection has to see what the viewer will see, or every
  // portrait upload gets encoded at the wrong rung.
  const swap = rotation === 90 || rotation === 270
  const width = swap ? video.height : video.width
  const height = swap ? video.width : video.height

  const fps = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate) || 25

  return {
    durationSec,
    width,
    height,
    fps,
    videoCodec: video.codec_name ?? 'unknown',
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    bitrateKbps: Math.round(Number(parsed.format?.bit_rate ?? 0) / 1000),
    sizeBytes: Number(parsed.format?.size ?? 0),
    rotation,
  }
}
