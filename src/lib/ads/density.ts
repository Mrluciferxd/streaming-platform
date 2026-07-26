'use client'

import { MAX_AD_VIEWPORT_FRACTION } from './config'

/**
 * Better Ads ad-density enforcement — plan §9: under 30% of the viewport.
 *
 * Reserving space for a slot and filling it are separate decisions here.
 * Reservation is a layout concern and happens unconditionally, which is what
 * keeps ad slots from moving the page (plan §8 caps CLS at 0.1, and slots that
 * size themselves after the creative arrives are the usual reason that number
 * is missed). Filling is a policy concern, and this is where it is made.
 *
 * A slot claims its area when it scrolls into view and releases it on the way
 * out, so the budget tracks what is actually on screen rather than what exists
 * in the document. That distinction is the whole point of the standard: four
 * units down a long page is fine, four units visible at once is not.
 *
 * Enforcing it in code rather than by choosing careful sizes is what makes it
 * hold on a 360x640 phone turned landscape, where three "small" units are
 * suddenly half the screen.
 */

type Claim = {
  area: number
  /** Admission order. Ties are broken newest-first when the budget shrinks. */
  sequence: number
  onRevoke: () => void
}

const claims = new Map<object, Claim>()
let sequence = 0
let listening = false
let pending = 0

function viewportArea(): number {
  if (typeof window === 'undefined') return 0
  return window.innerWidth * window.innerHeight
}

function budget(): number {
  return viewportArea() * MAX_AD_VIEWPORT_FRACTION
}

function claimedArea(): number {
  let total = 0
  for (const claim of claims.values()) total += claim.area
  return total
}

/**
 * Recheck after a resize or an orientation change. Over budget, the most
 * recently admitted slots go first: the one the viewer scrolled to and has been
 * looking at is the one worth keeping, and yanking it would read as a glitch.
 */
function reconcile(): void {
  const available = budget()
  if (claimedArea() <= available) return

  const ordered = [...claims.entries()].sort((a, b) => b[1].sequence - a[1].sequence)
  let total = claimedArea()

  for (const [token, claim] of ordered) {
    if (total <= available) break
    total -= claim.area
    claims.delete(token)
    claim.onRevoke()
  }

  if (claims.size === 0) stopListening()
}

function onResize(): void {
  // Coalesced into a frame: a drag-resize fires this continuously, and each
  // revocation tears down a GPT slot.
  if (pending) return
  pending = requestAnimationFrame(() => {
    pending = 0
    reconcile()
  })
}

function startListening(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('resize', onResize, { passive: true })
  window.addEventListener('orientationchange', onResize, { passive: true })
}

function stopListening(): void {
  if (!listening || typeof window === 'undefined') return
  listening = false
  window.removeEventListener('resize', onResize)
  window.removeEventListener('orientationchange', onResize)
  if (pending) {
    cancelAnimationFrame(pending)
    pending = 0
  }
}

/**
 * Ask for `area` square pixels of on-screen ad. Returns false if granting it
 * would break the 30% rule, in which case the caller leaves its reserved box
 * empty — the space is already committed either way, so refusing costs nothing
 * in layout stability.
 *
 * `onRevoke` fires if a later viewport change makes an existing grant
 * unaffordable.
 */
export function claimAdArea(token: object, area: number, onRevoke: () => void): boolean {
  if (typeof window === 'undefined' || area <= 0) return false

  const available = budget()
  // A single unit larger than the whole budget can never be shown, whatever
  // else is on screen.
  if (area > available) return false
  if (claimedArea() + area > available) return false

  claims.set(token, { area, sequence: ++sequence, onRevoke })
  startListening()
  return true
}

export function releaseAdArea(token: object): void {
  if (!claims.delete(token)) return
  if (claims.size === 0) stopListening()
}
