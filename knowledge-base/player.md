# Player

## What this subsystem does

Plays HLS in the browser: adaptive bitrate, manual quality, resume, keyboard and
gesture control, scrub-bar previews, and playback telemetry.

## How it is structured

```
src/components/player/
  VideoPlayer.tsx    Shell, controls, keyboard, gestures, fullscreen, PiP
  useHlsPlayer.ts    hls.js lifecycle, levels, error recovery, telemetry
  SeekBar.tsx        Scrub bar with sprite-sheet previews
  WatchPlayer.tsx    Fetches playback details, then mounts the player
  AdController.tsx   VAST pre-roll (see ads.md)
src/lib/player/
  resume.ts          localStorage positions + server sync
  thumbnails.ts      Sprite WebVTT parser, binary search by time
  analytics.ts       Event batcher
```

## Conventions and rules

- hls.js is imported dynamically so its ~50 KB gzipped bundle never reaches the
  home page.
- `WatchPlayer` fetches client-side on purpose: the playback endpoint sets a
  per-viewer cookie, and a cached server-rendered page must never carry one.
- The poster holds the exact final layout while loading, so the player swapping
  in causes no layout shift.

## Known gotchas

**ABR starts near 480p, not at the top rung.** Starting at 1080p on an Indian
mobile connection guarantees a spinner before the first frame, and
time-to-first-frame is what decides whether a streaming site feels fast or
broken. The initial bandwidth estimate is 1.5 Mbps rather than hls.js's 500 kbps
default.

**`capLevelToPlayerSize` is on.** A 1080p stream in a 360px viewport wastes
bandwidth the viewer pays for and egress the platform pays for.

**Two playback paths.** hls.js where MSE exists; native HLS otherwise, which in
practice is iOS Safari. Native HLS exposes no level control, so the quality menu
is *hidden* rather than rendered as a control that does nothing.

**Fatal hls.js errors are recovered, not fatal.** Network errors restart the
load, media errors call `recoverMediaError()`. Destroying on the first fatal
error would end playback over a single bad segment.

**Back buffer is capped at 30s.** An unbounded back buffer is a real cause of
tab crashes on cheap Android devices during long content.

**Resume writes every 5s, not on `timeupdate`.** That event fires ~4× a second;
writing per event would mean hundreds of localStorage writes a minute. Positions
also flush on `visibilitychange` and `pagehide`, because closing the tab
mid-video is the common case and the interval will not have fired.

**The resume floor must match the server.** `resume.ts` and
`src/lib/queries/history.ts` implement the same `least(15s, 5% of runtime)`
rule. If they diverge, Continue Watching differs depending on whether the viewer
is signed in (ISSUE-003).

**Sprite previews cost no requests.** The whole filmstrip is one cached image;
each cue is a `background-position` offset. Cue lookup is a binary search
because it runs on every pointer move along the bar.

## How it is tested

Not covered by automated tests — the player is DOM and media-element behaviour,
and there is no browser test harness. Verified manually in the browser against
the deployment: manifest parsed, ABR selected the correct rung for a 360p
source, segments and sprite VTT fetched, `currentTime` advancing, zero console
errors. `verify:hls` covers the *streams* the player consumes.

This is the largest untested surface in the codebase.

## Related

- [analytics.md](analytics.md) — what the player emits
- [storage-and-delivery.md](storage-and-delivery.md) — where segments come from
- [ads.md](ads.md) — pre-roll integration
