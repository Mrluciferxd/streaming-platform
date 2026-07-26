/**
 * Run the transcode pipeline against a local file, with no database and no
 * cloud credentials. Plan §15.3: prove the hardest technical component before
 * building anything on top of it.
 *
 *   npx tsx scripts/transcode-local.ts input.mp4 ./out
 *
 * With no arguments it synthesises a test clip with FFmpeg, so the pipeline can
 * be exercised on a machine with no media on it.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { transcodeToHls } from '../src/lib/video/pipeline.ts'
import { FFMPEG } from '../src/lib/video/probe.ts'

const run = promisify(execFile)

const outDir = path.resolve(process.argv[3] ?? './out')
let input = process.argv[2]

if (!input) {
  input = path.join(outDir, '_testsrc.mp4')
  await mkdir(outDir, { recursive: true })
  console.log('No input given — synthesising a 30s 1280x720 test clip…')

  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    input,
  ])
}

console.log(`\ninput:  ${input}\noutput: ${outDir}\n`)

const started = Date.now()
let lastStage = ''

const result = await transcodeToHls(input, outDir, (percent, stage) => {
  if (stage !== lastStage) {
    lastStage = stage
    process.stdout.write(`\n  ${stage.padEnd(10)}`)
  }
  process.stdout.write(`\r  ${stage.padEnd(10)} ${percent.toFixed(0).padStart(3)}%`)
})

const elapsed = (Date.now() - started) / 1000

console.log('\n')
console.log(`source     ${result.probe.width}x${result.probe.height} @ ${result.probe.fps.toFixed(2)}fps, ` +
  `${result.probe.durationSec.toFixed(1)}s, audio=${result.probe.hasAudio}`)
console.log(`encoded in ${elapsed.toFixed(1)}s (${(result.probe.durationSec / elapsed).toFixed(1)}x realtime)`)
console.log(`total      ${(result.totalBytes / 1e6).toFixed(1)} MB\n`)

console.table(
  result.variants.map((v) => ({
    rendition: v.name,
    resolution: v.height ? `${v.width}x${v.height}` : 'audio only',
    'target kbps': v.bitrateKbps,
    'peak kbps': v.peakBitrateKbps,
    'MB': (v.sizeBytes / 1e6).toFixed(2),
    'actual kbps': Math.round((v.sizeBytes * 8) / result.probe.durationSec / 1000),
  })),
)

console.log('\nmaster.m3u8\n')
console.log(
  (await readFile(result.masterPath, 'utf8'))
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n'),
)
