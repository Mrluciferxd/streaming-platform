'use client'

import { useEffect, useId, useRef, useState } from 'react'

import { gamNetworkCode } from '@/lib/ads/config'
import { claimAdArea, releaseAdArea } from '@/lib/ads/density'
import { renderDisplaySlot } from '@/lib/ads/display'
import { AD_SLOTS, sizeForWidth, type AdSlotName } from '@/lib/ads/slots'

/**
 * A display ad slot — header, below-player, sidebar, in-feed (plan §7 MVP).
 *
 * Built around one rule: **the box exists before the ad does, and its size
 * never depends on what comes back.** Plan §8 caps CLS at 0.1 and ad slots are
 * the standard way that budget is spent — a unit that sizes itself to the
 * creative moves everything under it, and it does so hundreds of milliseconds
 * after the page looked finished, which is exactly the shift the metric exists
 * to catch. So the height is a constant per breakpoint, no-fill does not
 * collapse it, and a slot the density budget turns down leaves it empty rather
 * than removing it.
 *
 * Three Better Ads rules from plan §9 are enforced here rather than noted:
 *
 *   - **Density under 30% of the viewport**, via `src/lib/ads/density.ts`. The
 *     budget gates whether a slot may *request* an ad, measured against what is
 *     on screen at the moment it asks.
 *   - **No prestitials.** Nothing here can overlay content or gate a page. A
 *     slot is a block in the document flow and has no other mode.
 *   - **Labelled.** Every filled unit carries a visible "Advertisement" marker,
 *     which is also what stops the in-feed unit reading as a title card.
 *
 * The request waits until the slot is near the viewport. Below-the-fold ad
 * requests fired on load compete for bandwidth with video that is still
 * loading, and they book unviewed impressions — which is the number every
 * network prices the next month's inventory on.
 */

type Props = {
  name: AdSlotName
  /** Layout for the surrounding band. The reserved box itself is fixed. */
  className?: string
}

/**
 * Per-slot visibility and reserved height, matching `AD_SLOTS`. Written as
 * literal class strings because Tailwind scans source text — a computed
 * `h-[${n}px]` produces no CSS at all, and it fails silently.
 */
const VISIBILITY: Record<AdSlotName, string> = {
  header: 'flex',
  below_player: 'flex',
  // There is no sidebar below lg, so there is no sidebar ad below lg.
  sidebar: 'hidden lg:flex',
  in_feed: 'flex',
}

const RESERVED_HEIGHT: Record<AdSlotName, string> = {
  header: 'h-[50px] md:h-[90px]',
  below_player: 'h-[100px] md:h-[90px]',
  sidebar: 'h-[250px]',
  in_feed: 'h-[250px]',
}

export function AdSlot({ name, className }: Props) {
  const spec = AD_SLOTS[name]
  /**
   * Visibility is measured on the reserved box, not on the GPT host inside it.
   * The host is an empty div until a creative lands, and a zero-area target is
   * not something IntersectionObserver reports on dependably. The box carries
   * the slot's real dimensions from first paint, which is what "in view" is
   * supposed to mean here anyway.
   */
  const boxRef = useRef<HTMLDivElement>(null)
  const reactId = useId()
  // GPT keys inventory by DOM id, so it has to be stable and CSS-safe.
  const elementId = `ad-${name}-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`

  const [filled, setFilled] = useState(false)

  useEffect(() => {
    const networkCode = gamNetworkCode
    if (!networkCode) return

    const box = boxRef.current
    if (!box) return

    /** Identity for this mount's density claim. */
    const token = {}
    let claimed = false
    let requested = false
    let teardown: (() => void) | null = null
    let cancelled = false

    const drop = () => {
      teardown?.()
      teardown = null
      requested = false
      setFilled(false)
    }

    const request = () => {
      const size = sizeForWidth(spec, window.innerWidth)
      // No size at this width means the slot is display:none anyway.
      if (!size) return

      const [width, height] = size
      // Turned down: over the Better Ads budget for what is currently on
      // screen. The reserved box stays exactly where it is, just empty, and the
      // next time the slot scrolls into view it asks again.
      if (!claimAdArea(token, width * height, drop)) return
      claimed = true

      if (requested) return
      requested = true
      setFilled(true)

      void renderDisplaySlot({
        spec,
        networkCode,
        elementId,
        // No fill. The box is already committed so nothing moves — but the
        // label should not claim an ad that is not there.
        onRender: (isEmpty) => {
          if (!cancelled && isEmpty) setFilled(false)
        },
      }).then((handle) => {
        if (!handle) return
        if (cancelled) {
          handle.destroy()
          return
        }
        teardown = handle.destroy
      })
    }

    const release = () => {
      if (!claimed) return
      claimed = false
      releaseAdArea(token)
      // The GPT slot is left alone: it was requested once and re-requesting it
      // on every scroll past would be impression inflation, which is what gets
      // an ad account closed (plan §9).
    }

    /**
     * 200px of lead time — enough for the request to land before the slot is
     * looked at, short enough that it is a slot the viewer is actually about to
     * reach.
     */
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) request()
          else release()
        }
      },
      { rootMargin: '200px' },
    )

    observer.observe(box)

    return () => {
      cancelled = true
      observer.disconnect()
      release()
      drop()
    }
  }, [spec, elementId])

  // Nothing configured: no box, no label, no footprint. An empty grey rectangle
  // on a site that runs no ads is worse than no rectangle.
  if (!gamNetworkCode) return null

  return (
    <aside
      aria-label="Advertisement"
      className={`${VISIBILITY[name]} w-full flex-col items-center gap-1 ${className ?? ''}`}
    >
      {/*
        Always rendered, only faded, so the label appearing with the creative
        cannot push the box down by a line.
      */}
      <span
        aria-hidden={!filled}
        className={`text-[10px] font-semibold tracking-[0.12em] text-muted uppercase transition-opacity ${
          filled ? 'opacity-100' : 'opacity-0'
        }`}
      >
        Advertisement
      </span>

      <div
        ref={boxRef}
        className={`${RESERVED_HEIGHT[name]} flex w-full items-center justify-center overflow-hidden rounded-2xl transition-colors ${
          filled ? 'bg-mist ring-1 ring-line' : ''
        }`}
      >
        <div id={elementId} />
      </div>
    </aside>
  )
}
