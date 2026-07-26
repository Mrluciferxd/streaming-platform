/**
 * Ad configuration, client-safe.
 *
 * Everything here is optional and everything is off unless explicitly switched
 * on. An unconfigured deploy loads no third-party script, requests no ad, and
 * renders no slot — the site behaves exactly as it did before this directory
 * existed. That is not politeness: an ad stack that half-initialises is the
 * usual way a player ends up spinning forever on a viewer who blocked it.
 *
 * This duplicates the `NEXT_PUBLIC_*` block in src/lib/env.ts, deliberately.
 * env.ts throws at import when the server variables are missing, so a client
 * component cannot import it; and Next only inlines `process.env.NEXT_PUBLIC_X`
 * into the browser bundle when the property access is written out literally, so
 * the reads below cannot be looped or indirected either. env.ts stays the place
 * a malformed value is caught at boot; this is the place the browser reads it.
 */

const enabledFlag = process.env.NEXT_PUBLIC_ADS_ENABLED === '1'
const vastTagUrl = process.env.NEXT_PUBLIC_AD_VAST_TAG_URL?.trim() ?? ''
const networkCode = process.env.NEXT_PUBLIC_GAM_NETWORK_CODE?.trim() ?? ''
const capRaw = process.env.NEXT_PUBLIC_AD_PREROLL_CAP
const cooldownRaw = process.env.NEXT_PUBLIC_AD_PREROLL_COOLDOWN_SEC

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Defaults chosen against a binge, not against a single view.
 *
 * Three per session with ten minutes between them means a viewer who watches
 * six episodes back to back sees three pre-rolls, not six. Plan §9 prices
 * pre-roll as the highest-value inventory, so the cap is not there to be
 * generous — it is there because the alternative loses the session that would
 * have produced the later impressions anyway.
 */
const DEFAULT_PREROLL_CAP = 3
const DEFAULT_PREROLL_COOLDOWN_SEC = 600

export type PreRollConfig = {
  tagUrl: string
  /** Mirrors `ad_placements.frequency_cap`: impressions per browsing session. */
  cap: number
  cooldownMs: number
}

/** Master switch. Both inventory types are additionally gated on their own config. */
export const adsEnabled = enabledFlag

/**
 * Pre-roll config, or null when there is nothing to request. Null is the signal
 * the player uses to skip the ad path entirely rather than to fail through it.
 */
export const preRoll: PreRollConfig | null =
  adsEnabled && vastTagUrl
    ? {
        tagUrl: vastTagUrl,
        cap: positiveInt(capRaw, DEFAULT_PREROLL_CAP),
        cooldownMs: positiveInt(cooldownRaw, DEFAULT_PREROLL_COOLDOWN_SEC) * 1000,
      }
    : null

/** GAM network code. Display slots need it to build an ad unit path. */
export const gamNetworkCode: string | null = adsEnabled && networkCode ? networkCode : null

export const displayAdsEnabled = gamNetworkCode !== null

/**
 * Better Ads (plan §9). The share of the viewport ads may occupy at once.
 * Enforced in src/lib/ads/density.ts, not left to careful slot sizing.
 */
export const MAX_AD_VIEWPORT_FRACTION = 0.3

/**
 * How long the pre-roll may hold the viewer before the content starts anyway.
 *
 * This is the number that decides whether a broken ad server costs an
 * impression or costs the session. It is short on purpose.
 */
export const AD_START_TIMEOUT_MS = 6000

/**
 * Give up on an SDK script that never arrives. Blockers sometimes null-route
 * the host rather than refuse it, producing neither `load` nor `error`.
 *
 * Deliberately generous, because nothing waits on this: the player asks whether
 * an ad is ready at the instant the viewer presses play and moves on if it is
 * not, and a display slot that fills late costs the viewer nothing at all. The
 * viewer-facing deadline is AD_START_TIMEOUT_MS above. Set this too tight — 4s
 * was the first guess — and the only thing it achieves is throwing away
 * inventory on exactly the slow connections this platform is built for.
 */
export const SDK_LOAD_TIMEOUT_MS = 10_000
