/**
 * "Continue Watching" positions (plan §7 MVP).
 *
 * Stored in localStorage rather than `watch_history`, because that table keys
 * on `user_id` and there are no accounts yet. This keeps the feature working
 * for anonymous viewers — which, before auth ships, is all of them — and the
 * shape maps one-to-one onto the table for a later merge on sign-in.
 */

const KEY = 'resume.v1'
const MAX_ENTRIES = 200

/** Below this, the viewer barely started; above the tail, they effectively finished. */
const MIN_RESUME_SECONDS = 15
const COMPLETE_FRACTION = 0.95

export type ResumeEntry = {
  videoId: string
  positionSec: number
  durationSec: number
  updatedAt: number
}

function readAll(): Record<string, ResumeEntry> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, ResumeEntry>) : {}
  } catch {
    // Corrupt or unavailable storage (private mode, quota) must never break
    // playback — resume is a convenience, not a requirement.
    return {}
  }
}

function writeAll(entries: Record<string, ResumeEntry>): void {
  if (typeof window === 'undefined') return

  try {
    // Evict oldest first so a heavy viewer does not grow this without bound.
    const sorted = Object.values(entries).sort((a, b) => b.updatedAt - a.updatedAt)
    const kept = Object.fromEntries(sorted.slice(0, MAX_ENTRIES).map((e) => [e.videoId, e]))

    window.localStorage.setItem(KEY, JSON.stringify(kept))
  } catch {
    /* quota exceeded — drop it */
  }
}

export function savePosition(videoId: string, positionSec: number, durationSec: number): void {
  if (!Number.isFinite(positionSec) || !Number.isFinite(durationSec) || durationSec <= 0) return

  const entries = readAll()

  // Finished, or barely started: nothing worth resuming. Clearing on completion
  // is what stops a watched video sitting in Continue Watching forever.
  if (positionSec < MIN_RESUME_SECONDS || positionSec / durationSec >= COMPLETE_FRACTION) {
    delete entries[videoId]
  } else {
    entries[videoId] = {
      videoId,
      positionSec: Math.floor(positionSec),
      durationSec: Math.floor(durationSec),
      updatedAt: Date.now(),
    }
  }

  writeAll(entries)
}

export function getPosition(videoId: string): number | null {
  return readAll()[videoId]?.positionSec ?? null
}

export function clearPosition(videoId: string): void {
  const entries = readAll()
  delete entries[videoId]
  writeAll(entries)
}

/** Most recently watched first — the Continue Watching rail. */
export function listInProgress(limit = 20): ResumeEntry[] {
  return Object.values(readAll())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}
