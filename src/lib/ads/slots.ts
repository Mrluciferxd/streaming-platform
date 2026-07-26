import type { GptSize } from './types'

/**
 * The display inventory from plan §7 MVP, with its dimensions fixed here rather
 * than inferred from whatever the ad server returns.
 *
 * Two sizes per slot at most, and the breakpoint between them is explicit. A
 * responsive slot that measures itself and then asks for a matching creative
 * has to reserve space before it knows what it will get, which is how ad units
 * end up either padded with dead space or shifting the page when the creative
 * lands. Committing to a size per breakpoint means the reserved box is right
 * the first time.
 *
 * Sizes are the IAB standards GAM fills reliably; a size nobody bids on is
 * worth less than a smaller one that fills. They are also chosen to stay inside
 * the Better Ads viewport budget on a small phone — a 300x250 below the player
 * is common practice and is roughly a third of a 360x640 screen on its own,
 * which is why the mobile below-player unit here is a 320x100 instead.
 */

export type AdSlotName = 'header' | 'below_player' | 'sidebar' | 'in_feed'

export type AdSlotSpec = {
  /**
   * GAM ad unit, appended to the network code. These must exist in the GAM
   * account as child units before the slot will fill.
   */
  adUnit: string
  /** Below `wideFrom`. Null means the slot does not render at that width. */
  narrow: GptSize | null
  /** At or above `wideFrom`. */
  wide: GptSize | null
  wideFrom: number
}

export const AD_SLOTS: Record<AdSlotName, AdSlotSpec> = {
  header: {
    adUnit: 'web_header',
    narrow: [320, 50],
    wide: [728, 90],
    wideFrom: 768,
  },
  below_player: {
    adUnit: 'web_below_player',
    narrow: [320, 100],
    wide: [728, 90],
    wideFrom: 768,
  },
  sidebar: {
    adUnit: 'web_sidebar',
    // There is no sidebar on a phone, so there is no sidebar ad on one either.
    narrow: null,
    wide: [300, 250],
    wideFrom: 1024,
  },
  in_feed: {
    adUnit: 'web_in_feed',
    /**
     * A band of its own between rows rather than a card shaped like a poster.
     * A 2:3 unit dropped into the grid would read as a title until clicked,
     * which is the deceptive-native pattern both the Better Ads standards and
     * every ad network's own policy prohibit.
     */
    narrow: [300, 250],
    wide: [300, 250],
    wideFrom: 768,
  },
}

/** `/{network}/{unit}` — the path GPT identifies inventory by. */
export function adUnitPath(networkCode: string, spec: AdSlotSpec): string {
  return `/${networkCode}/${spec.adUnit}`
}

/** Every size the slot may serve, which is what GPT is asked to bid on. */
export function slotSizes(spec: AdSlotSpec): GptSize[] {
  const sizes: GptSize[] = []
  if (spec.narrow) sizes.push(spec.narrow)
  if (spec.wide && (!spec.narrow || spec.wide[0] !== spec.narrow[0] || spec.wide[1] !== spec.narrow[1])) {
    sizes.push(spec.wide)
  }
  return sizes
}

/** The size that will actually render at `viewportWidth`, or null for none. */
export function sizeForWidth(spec: AdSlotSpec, viewportWidth: number): GptSize | null {
  return viewportWidth >= spec.wideFrom ? spec.wide : spec.narrow
}
