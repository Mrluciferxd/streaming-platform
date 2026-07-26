# Video Pipeline

## What this subsystem does

Turns an uploaded source file into a playable adaptive-bitrate HLS package:
probe, ladder, packaging, poster, sprite sheet, hover preview — then uploads the
result and records the renditions.

## How it is structured

```
src/lib/video/
  probe.ts     ffprobe wrapper — duration, dimensions, fps, audio, rotation
  encode.ts    Rung selection, FFmpeg argument construction, master playlist
  sprite.ts    Poster, sprite sheet, WebVTT index, animated preview
  pipeline.ts  Orchestration: source in, complete package on disk out
worker/
  index.ts     Claim → heartbeat → run → complete/fail, graceful shutdown
  transcode.ts One job: download, transcode, upload, publish metadata
src/lib/jobs/queue.ts   Postgres SKIP LOCKED queue
```

`pipeline.ts` deliberately knows nothing about storage or the database, so it
can be run and inspected with no credentials: `npm run transcode:local`.

## Conventions and rules

- Never upscale. Rungs are filtered against the source.
- Segments are 6 seconds — fewer objects means fewer per-request storage reads.
- Keyframes every 2 seconds, forced onto a fixed clock, scene-cut detection off.
- Capped VBR on every rung; the playlist advertises the *cap*.
- One shared audio rendition referenced by an HLS audio group.
- `ready`, not `published`, when a transcode finishes. Publishing is an operator
  decision.

## Known gotchas

**Rungs match the shorter side, not the height.** A 480×854 phone video has a
height of 854, so height-matching picks a "720p" rung and encodes 405×720 at
2800 kbps — about three times the bitrate those pixels need, paid on every byte
delivered. Portrait is a large share of uploads on a mobile-first platform.

**Capped VBR is not optional.** The plan's reference command sets `-b:v` with no
`-maxrate`/`-bufsize`, so libx264 overshoots on complex scenes and the declared
`BANDWIDTH` understates reality. hls.js picks rungs by comparing measured
throughput against that number, so an understated value makes it choose a stream
the connection cannot carry — surfacing as exactly the rebuffering plan §8 caps
at 0.5%.

**Keyframes must align across rungs or switching stutters.** Scene-cut keyframes
land at different timestamps in each rendition. This plays fine in a casual test
and fails under ABR switching, which is why `verify:hls` asserts boundary
alignment rather than trusting it.

**One shared audio rendition, not audio muxed per variant.** The plan's command
maps `a:0` three times: ~3× audio storage, and it makes multi-audio-track
support impossible to add later without re-encoding the library. An audio group
also yields the audio-only rendition for poor connections for free.

**Dimensions round to the nearest even number**, not up. 16:9 at 240p is 426.67;
rounding up gives 428 where every reference ladder says 426.

**Rotation metadata must be honoured.** A phone-shot portrait video reports
landscape dimensions plus a rotation flag; ignoring it puts every portrait
upload on the wrong rung.

**The worker heartbeats every 30s.** A transcode legitimately runs 20+ minutes,
so a plain lock timeout cannot distinguish a long encode from an OOM-killed
worker. The reaper requeues only jobs whose heartbeat has actually gone stale.

**Input that will never decode is killed, not retried.** Three multi-minute
attempts at a corrupt file before anyone notices is pure waste.

**Temp directories are removed in `finally`.** Several GB per job; leaving them
fills the worker's disk within a day and every subsequent job fails on write.

## How it is tested

- `npm run check:ladder` — rung selection across seven aspect ratios: never
  upscales, dimensions even, aspect preserved, peak above target, portrait gets
  the same bitrate as equivalent landscape.
- `npm run transcode:local` then `npm run verify:hls` — a real FFmpeg run, then
  29 structural checks: keyframe alignment across renditions, real bitrate
  within declared `BANDWIDTH`, audio stored once, fMP4 init segments, closed VOD
  playlists, decodability, sprite VTT using `#xywh` fragments.
- `npm run check:queue` — 23 assertions including 20 concurrent claimers
  partitioning 8 jobs with no duplication, backoff, dead-lettering, reaping.

Verified end to end on landscape, portrait and silent sources at ~8× realtime.
Not verified: the upload/download legs against a real bucket (ISSUE-001).

## Related

- [storage-and-delivery.md](storage-and-delivery.md) — where packages go
- [admin.md](admin.md) — the upload surface that starts a job
- [database.md](database.md) — `jobs`, `uploads`, `video_variants`
