/**
 * Validates an HLS package produced by the pipeline.
 *
 *   npx tsx scripts/verify-hls.ts ./out
 *
 * Checks the properties that are silent when broken — a stream can play fine in
 * a quick manual test and still stutter on every quality switch, or overshoot
 * the bitrate it advertises and cause rebuffering on exactly the connections
 * this platform targets.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { FFPROBE } from '../src/lib/video/probe.ts'
import { SEGMENT_SECONDS } from '../src/lib/video/types.ts'

const run = promisify(execFile)
const dir = path.resolve(process.argv[2] ?? './out')

let failures = 0
function check(ok: boolean, label: string, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const master = await readFile(path.join(dir, 'master.m3u8'), 'utf8')

// --- Master playlist structure ---------------------------------------------
check(master.startsWith('#EXTM3U'), 'master starts with #EXTM3U')
check(master.includes('#EXT-X-VERSION:7'), 'version 7 (required for fMP4)')
check(master.includes('#EXT-X-INDEPENDENT-SEGMENTS'), 'independent segments declared')

const streamLines = [...master.matchAll(/#EXT-X-STREAM-INF:([^\n]+)\n([^\n]+)/g)]
check(streamLines.length > 0, 'master lists at least one variant', `${streamLines.length} variants`)

const audioGroup = master.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*GROUP-ID="([^"]+)"/)
if (audioGroup) {
  check(
    streamLines.every((m) => m[1]!.includes(`AUDIO="${audioGroup[1]}"`)),
    'every variant references the audio group',
  )
  // The whole point of a shared audio group: audio is stored once.
  const audioDirs = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name === 'audio')
  check(audioDirs.length === 1, 'audio stored once, not muxed per variant')
}

// --- Per-variant checks -----------------------------------------------------
const segmentBoundaries: Record<string, number[]> = {}

for (const [, attrs, uri] of streamLines) {
  const name = uri!.split('/')[0]!
  const playlist = await readFile(path.join(dir, uri!), 'utf8')

  check(playlist.includes('#EXT-X-MAP:URI='), `${name}: has fMP4 init segment`)
  check(playlist.includes('#EXT-X-ENDLIST'), `${name}: VOD playlist is closed`)

  // Cumulative segment start times, for the alignment check below.
  const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]))
  const boundaries: number[] = []
  let t = 0
  for (const d of durations) {
    boundaries.push(Number(t.toFixed(3)))
    t += d
  }
  segmentBoundaries[name] = boundaries

  const overLong = durations.filter((d) => d > SEGMENT_SECONDS + 0.5)
  check(
    overLong.length === 0,
    `${name}: segments within ${SEGMENT_SECONDS}s target`,
    overLong.length ? `${overLong.length} over` : `${durations.length} segments`,
  )

  // Declared BANDWIDTH must not be lower than what the variant actually
  // delivers. hls.js selects on this number; if it lies low, the player picks a
  // stream the connection cannot sustain and the viewer rebuffers.
  const declaredPeak = Number(attrs!.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0)
  const variantDir = path.join(dir, name)
  const files = await readdir(variantDir)
  let bytes = 0
  for (const f of files) bytes += (await stat(path.join(variantDir, f))).size

  const actualAvgBps = (bytes * 8) / t
  check(
    actualAvgBps <= declaredPeak,
    `${name}: real bitrate within declared BANDWIDTH`,
    `${Math.round(actualAvgBps / 1000)} kbps actual vs ${Math.round(declaredPeak / 1000)} kbps declared`,
  )
}

// --- Keyframe alignment -----------------------------------------------------
// Renditions must be switchable at any segment boundary. If boundaries drift,
// switching stalls or stutters — the failure the plan's fixed -g setting is
// meant to prevent, and the one most likely to survive a casual manual test.
const names = Object.keys(segmentBoundaries)
const reference = segmentBoundaries[names[0]!]!
let aligned = true
let mismatch = ''

for (const name of names.slice(1)) {
  const b = segmentBoundaries[name]!
  if (b.length !== reference.length) {
    aligned = false
    mismatch = `${name} has ${b.length} segments, ${names[0]} has ${reference.length}`
    break
  }
  for (let i = 0; i < b.length; i++) {
    if (Math.abs(b[i]! - reference[i]!) > 0.05) {
      aligned = false
      mismatch = `${name} segment ${i} starts at ${b[i]}s, ${names[0]} at ${reference[i]}s`
      break
    }
  }
  if (!aligned) break
}

check(aligned, 'segment boundaries aligned across renditions', mismatch)

// --- Decodability -----------------------------------------------------------
// Structure can be perfect and the media still be undecodable.
try {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-allowed_extensions', 'ALL',
    path.join(dir, streamLines[0]![2]!),
  ])
  const streams = (JSON.parse(stdout) as { streams?: unknown[] }).streams ?? []
  check(streams.length > 0, 'first variant decodes with ffprobe')
} catch (error) {
  check(false, 'first variant decodes with ffprobe', String(error).slice(0, 200))
}

// --- Companion assets -------------------------------------------------------
for (const asset of ['poster.jpg', 'sprite.jpg', 'sprite.vtt']) {
  try {
    const s = await stat(path.join(dir, asset))
    check(s.size > 0, `${asset} present and non-empty`, `${(s.size / 1024).toFixed(0)} KB`)
  } catch {
    check(false, `${asset} present and non-empty`, 'missing')
  }
}

const vtt = await readFile(path.join(dir, 'sprite.vtt'), 'utf8')
check(vtt.startsWith('WEBVTT'), 'sprite.vtt is valid WebVTT')
check(/#xywh=\d+,\d+,\d+,\d+/.test(vtt), 'sprite.vtt uses #xywh media fragments')

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
