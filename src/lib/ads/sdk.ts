'use client'

import { SDK_LOAD_TIMEOUT_MS } from './config'
import type { Googletag, ImaSdk } from './types'

/**
 * Loaders for the two Google ad scripts.
 *
 * Both resolve to `null` instead of rejecting. Every caller has exactly one
 * thing to do when the script does not arrive — carry on without ads — so a
 * rejection would only buy a `.catch()` at each call site and a chance to
 * forget one. A forgotten one on the player path is a viewer watching a
 * spinner because they run an ad blocker, which is a large share of them.
 *
 * The timeout matters as much as the error handler: blockers that null-route
 * the host at DNS level produce neither `load` nor `error`, just a request that
 * hangs. Without a deadline that hang becomes the player's.
 */

const IMA_SDK_URL = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js'
const GPT_URL = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'

function loadScript(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
    if (existing) {
      // A second player mounting mid-load must wait on the same element rather
      // than injecting a duplicate.
      existing.addEventListener('load', () => resolve(true), { once: true })
      existing.addEventListener('error', () => resolve(false), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = src
    script.async = true

    const deadline = setTimeout(() => resolve(false), SDK_LOAD_TIMEOUT_MS)
    script.addEventListener('load', () => {
      clearTimeout(deadline)
      resolve(true)
    })
    script.addEventListener('error', () => {
      clearTimeout(deadline)
      resolve(false)
    })

    document.head.appendChild(script)
  })
}

let imaLoad: Promise<ImaSdk | null> | null = null

export function loadImaSdk(): Promise<ImaSdk | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)
  if (window.google?.ima) return Promise.resolve(window.google.ima)

  imaLoad ??= loadScript(IMA_SDK_URL).then(() => window.google?.ima ?? null)
  return imaLoad
}

let gptLoad: Promise<Googletag | null> | null = null

export function loadGpt(): Promise<Googletag | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)

  gptLoad ??= (() => {
    // GPT's command queue is created before the script so calls can be queued
    // against a script that has not landed — and, if it never lands, so the
    // queue is simply an array nobody drains rather than a TypeError.
    window.googletag ??= { cmd: [] } as unknown as Googletag

    return loadScript(GPT_URL).then((ok) =>
      ok && typeof window.googletag?.defineSlot === 'function' ? window.googletag : null,
    )
  })()

  return gptLoad
}
