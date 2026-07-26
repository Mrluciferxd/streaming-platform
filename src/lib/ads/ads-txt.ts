import { env } from '@/lib/env'

/**
 * ads.txt / app-ads.txt generation (plan §7 MVP, §9).
 *
 * Generated from configuration rather than committed as a static file for one
 * reason: the file is a live authorisation list. Adding a demand partner means
 * editing it the same day, and a static asset makes that a code change and a
 * deploy — which is how sites end up running a partner for weeks with no record
 * authorising them, and buyers filtering the inventory out.
 *
 * Accuracy matters more than completeness. An unauthorised seller in this file
 * is an open invitation to domain spoofing; a missing one silently suppresses
 * bids. So there is no placeholder: with nothing configured the routes return
 * 404, which is the correct signal for "this publisher has no authorised
 * sellers yet". A file full of examples would be read as fact.
 */

/**
 * Google's certification authority id in the TAG registry. Constant for every
 * publisher, and required on Google records for the line to validate.
 */
const GOOGLE_TAG_ID = 'f08c47fec0942fa0'

/** Minimum fields in a valid record: domain, publisher id, relationship. */
const MIN_RECORD_FIELDS = 3

function parseEntries(raw: string | undefined): string[] {
  if (!raw) return []

  return raw
    // Semicolons as well as newlines: most hosting dashboards make a
    // multi-line environment variable awkward to enter.
    .split(/[;\n]/)
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false
      if (line.startsWith('#')) return true
      // Anything that cannot be a record is dropped rather than published.
      // Crawlers ignore malformed lines anyway; shipping them just makes the
      // file harder to audit against what the ad server actually has.
      return line.split(',').length >= MIN_RECORD_FIELDS
    })
}

export function buildAdsTxt(): string | null {
  const lines: string[] = []

  if (env.ADS_TXT_GOOGLE_PUB_ID) {
    lines.push(`google.com, ${env.ADS_TXT_GOOGLE_PUB_ID}, DIRECT, ${GOOGLE_TAG_ID}`)
  }

  lines.push(...parseEntries(env.ADS_TXT_ENTRIES))

  if (lines.length === 0) return null

  if (env.ADS_TXT_CONTACT) {
    // A variable line, not a record — it tells buyers who to reach about the
    // inventory, and it is the only part of the file a human reads.
    lines.push(`CONTACT=${env.ADS_TXT_CONTACT}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * app-ads.txt is the same authorisation list for in-app inventory. It stays off
 * by default: publishing one without an app in a store listing that points back
 * at this domain authorises sellers for inventory that does not exist, and
 * unmatched app-ads.txt files are a documented spoofing vector.
 */
export function buildAppAdsTxt(): string | null {
  return env.ADS_TXT_APP_ADS ? buildAdsTxt() : null
}
