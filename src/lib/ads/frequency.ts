'use client'

/**
 * Pre-roll frequency capping — plan §7 MVP, `ad_placements.frequency_cap`.
 *
 * Session-scoped, so the state lives in sessionStorage. The `sid` cookie the
 * analytics pipeline groups on is a year-long visitor id, not a session: cap
 * against that and a viewer sees one pre-roll a year. sessionStorage is per
 * tab and dies with it, which is the closest thing the browser offers to
 * "this sitting".
 *
 * Three rules, and the second is the one that earns its keep:
 *
 *   - at most `cap` pre-rolls per session
 *   - at least `cooldownMs` between them. Without this a cap of three still
 *     means an ad on episodes 1, 2 and 3 of a binge — the exact pattern that
 *     ends the session before the impressions the cap was protecting
 *   - never twice for the same video, so a reload, a resume, or a rewatch is
 *     not a second ad break for content the viewer already sat through one for
 *
 * Every failure mode here resolves to "show the ad" rather than "block
 * playback", and storage being unavailable degrades to an in-memory cap that
 * survives client-side navigation within the tab.
 */

const KEY = 'ads.preroll.v1'
/** Bounded so a long session cannot grow the record without limit. */
const MAX_REMEMBERED_VIDEOS = 60

type PreRollState = {
  count: number
  lastAt: number
  videos: string[]
}

const EMPTY: PreRollState = { count: 0, lastAt: 0, videos: [] }

/**
 * Fallback for private modes and blocked-storage configurations. Module scope
 * outlives client-side route changes, so a binge navigated with the App Router
 * is still capped; only a hard reload resets it.
 */
let memory: PreRollState = EMPTY

function read(): PreRollState {
  if (typeof window === 'undefined') return EMPTY

  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return memory

    const parsed = JSON.parse(raw) as Partial<PreRollState>
    return {
      count: typeof parsed.count === 'number' ? parsed.count : 0,
      lastAt: typeof parsed.lastAt === 'number' ? parsed.lastAt : 0,
      videos: Array.isArray(parsed.videos) ? parsed.videos.filter((v) => typeof v === 'string') : [],
    }
  } catch {
    return memory
  }
}

function write(state: PreRollState): void {
  memory = state
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* quota or blocked storage — the in-memory copy above still caps the tab */
  }
}

export type PreRollDecision =
  | { show: true }
  | { show: false; reason: 'cap' | 'cooldown' | 'already-seen' }

export function preRollDecision(
  videoId: string,
  limits: { cap: number; cooldownMs: number },
): PreRollDecision {
  const state = read()

  if (state.videos.includes(videoId)) return { show: false, reason: 'already-seen' }
  if (state.count >= limits.cap) return { show: false, reason: 'cap' }
  if (state.lastAt > 0 && Date.now() - state.lastAt < limits.cooldownMs) {
    return { show: false, reason: 'cooldown' }
  }

  return { show: true }
}

/**
 * Record an impression. Called when the ad actually starts rendering, not when
 * it is requested — a request that returns no fill has cost the viewer nothing
 * and must not consume their cap.
 */
export function recordPreRoll(videoId: string): void {
  const state = read()

  write({
    count: state.count + 1,
    lastAt: Date.now(),
    videos: [videoId, ...state.videos.filter((v) => v !== videoId)].slice(
      0,
      MAX_REMEMBERED_VIDEOS,
    ),
  })
}
