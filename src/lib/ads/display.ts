'use client'

import { loadGpt } from './sdk'
import { adUnitPath, slotSizes, type AdSlotSpec } from './slots'
import type { GptSlot, GptSlotRenderEvent } from './types'

/**
 * Google Publisher Tag slot lifecycle.
 *
 * GPT is configured here rather than at each call site because two of the
 * settings are load-bearing and both are easy to lose:
 *
 *   - `collapseEmptyDivs(false)`. GPT's default is to collapse a slot that
 *     returns no fill, which removes its height and shifts everything under it
 *     — a layout shift caused by an ad that did not even exist. The reserved
 *     box stays whatever happens.
 *
 *   - `setForceSafeFrame(true)`. Without it GPT renders creatives into a
 *     same-origin iframe, and a same-origin iframe inherits this page's CSP, so
 *     every creative hosted anywhere but the handful of Google origins allowed
 *     in next.config.ts is blocked. SafeFrame renders them cross-origin under
 *     Google's own policy instead, which means the page CSP does not have to be
 *     opened up to the whole internet for display ads to work. It costs a
 *     little demand — a minority of creatives decline to run in SafeFrame — and
 *     that is a trade worth making.
 */

let servicesEnabled = false

export type DisplaySlotHandle = { destroy: () => void }

export async function renderDisplaySlot(options: {
  spec: AdSlotSpec
  networkCode: string
  elementId: string
  /** Called with true when the slot came back with no creative. */
  onRender?: (isEmpty: boolean) => void
}): Promise<DisplaySlotHandle | null> {
  const googletag = await loadGpt()
  if (!googletag) return null

  const { spec, networkCode, elementId, onRender } = options

  let slot: GptSlot | null = null
  let renderListener: ((event: GptSlotRenderEvent) => void) | null = null
  let destroyed = false

  googletag.cmd.push(() => {
    if (destroyed) return

    const pubads = googletag.pubads()

    if (!servicesEnabled) {
      servicesEnabled = true
      // One request for every slot defined in the same tick. Slots that mount
      // later get their own request, which is the price of not holding the
      // first ones behind the slowest component on the page.
      pubads.enableSingleRequest()
      pubads.collapseEmptyDivs(false)
      pubads.setForceSafeFrame(true)
      pubads.setCentering(true)
      googletag.enableServices()
    }

    const defined = googletag.defineSlot(adUnitPath(networkCode, spec), slotSizes(spec), elementId)
    if (!defined) return

    slot = defined
      .addService(pubads)
      // Belt and braces: the service-wide setting above already disables
      // collapsing, but a slot-level default would still win over it.
      .setCollapseEmptyDiv(false, false)

    if (onRender) {
      renderListener = (event) => {
        if (event.slot.getSlotElementId() === elementId) onRender(event.isEmpty)
      }
      pubads.addEventListener('slotRenderEnded', renderListener)
    }

    googletag.display(defined)
  })

  return {
    destroy() {
      destroyed = true

      googletag.cmd.push(() => {
        if (renderListener) {
          googletag.pubads().removeEventListener('slotRenderEnded', renderListener)
          renderListener = null
        }
        if (slot) {
          googletag.destroySlots([slot])
          slot = null
        }
      })
    },
  }
}
