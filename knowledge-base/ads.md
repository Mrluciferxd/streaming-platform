# Ads

## What this subsystem does

The revenue side: VAST pre-roll through the Google IMA SDK, display slots,
frequency capping, `ads.txt`, and impression telemetry.

## How it is structured

```
src/lib/ads/
  config.ts     Env-driven configuration; ads off unless configured
  sdk.ts        IMA SDK loading
  preroll.ts    VAST request and playback handoff
  frequency.ts  Per-session capping
  density.ts    Better Ads constraints
  slots.ts, display.ts, types.ts, ads-txt.ts
src/components/player/AdController.tsx   Player integration
src/components/ads/AdSlot.tsx            Display units
src/app/ads.txt/route.ts, app-ads.txt/route.ts
```

## Conventions and rules

- **Ads are off by default.** Unconfigured ads must never break playback.
- Ad logic stays in its own module; `VideoPlayer.tsx` knows as little as
  possible about it.
- Display slots reserve explicit dimensions.

## Known gotchas

**Ad failure must fall through to content immediately.** Ad-blocked and
ad-failed are the common cases, not edge cases. A viewer must never sit on a
spinner because an ad did not load.

**Frequency capping is per session.** A pre-roll on every episode of a binge is
the fastest way to lose an anime audience.

**Reserve slot dimensions or CLS blows.** Unreserved ad slots are the usual way
a Core Web Vitals budget is lost, and plan §8 caps CLS at 0.1.

**The CSP allowlists specific Google hosts**, not `*.google.com` or
`*.doubleclick.net`. The IMA SDK, `securepubads`, `pagead2` and
`googleads.g.doubleclick.net` are listed individually in `next.config.ts`.

**Invalid traffic gets ad accounts banned.** Rate limiting on `/api/events`
exists partly for this reason (plan §9).

**Content rights are the real constraint.** Anime is almost entirely licensed,
and AdSense/GAM will ban a site hosting content the operator has no rights to.
This is a content-acquisition problem, not a technical one, but it determines
whether any of this earns anything.

## How it is tested

Not verified against real inventory (ISSUE-007). The integration path is
implemented and typechecked; fill, capping and telemetry need a GAM account and
a live VAST tag to confirm.

## Related

- [player.md](player.md) — where pre-roll hooks in
- [analytics.md](analytics.md) — `ad_impression` / `ad_complete` events
