'use client'

import { AD_START_TIMEOUT_MS } from './config'
import { loadImaSdk } from './sdk'
import type { ImaAdsLoader, ImaAdsManager, ImaAdDisplayContainer, ImaEvent, ImaSdk } from './types'

/**
 * VAST pre-roll via the Google IMA SDK (plan §9), driven imperatively so the
 * React layer above it stays a thin wrapper.
 *
 * The contract with the player is one sentence: **content playback is never
 * blocked on anything in this file.** A session that is still loading, was
 * blocked, returned no fill, errored, or simply took too long resolves to "no
 * ad" and the viewer watches their video. Every branch below either starts an
 * ad promptly or gets out of the way; there is deliberately no state in which
 * the viewer waits on an ad server.
 *
 * That is also why `tryStart` is synchronous and returns a boolean rather than
 * a promise. The player asks, at the instant the viewer presses play, whether
 * there is an ad ready *right now*. If the answer needed awaiting, the honest
 * implementation would be a spinner, and a spinner is the failure this module
 * is written to avoid.
 */

export type PreRollOutcome =
  /** Ad played to the end. */
  | 'complete'
  /** Viewer skipped after the skip offset. Still a billable impression. */
  | 'skipped'
  /** Never rendered: no fill, a bad tag, a creative that would not load. */
  | 'error'
  /** Rendered nothing inside the deadline, so content took the screen back. */
  | 'timeout'

export type PreRollStatus = 'loading' | 'ready' | 'playing' | 'unavailable' | 'finished'

export type PreRollOptions = {
  /** Overlay IMA renders into. Must already cover the player box. */
  adContainer: HTMLElement
  /** The content element. Paused for the break and resumed after it. */
  video: HTMLVideoElement
  tagUrl: string
  /** The ad break is starting — put the overlay up. */
  onBreakStart: () => void
  /** A creative is now on screen. This is the impression. */
  onAdStarted: () => void
  /** The break is over for any reason. Content is already playing again. */
  onBreakEnd: (outcome: PreRollOutcome) => void
}

export type PreRollSession = {
  status: () => PreRollStatus
  /**
   * Call from inside a real user gesture. IMA can only unlock an ad video
   * element for sound from within one, and on iOS the ad is silent otherwise.
   */
  primeForGesture: () => void
  /** True when an ad break has begun and the overlay should be shown. */
  tryStart: () => boolean
  /** Seconds left in the current creative, or null when nothing is playing. */
  remainingSec: () => number | null
  syncVolume: () => void
  resize: () => void
  destroy: () => void
}

export function createPreRollSession(options: PreRollOptions): PreRollSession {
  const { adContainer, video, tagUrl } = options

  let sdk: ImaSdk | null = null
  let displayContainer: ImaAdDisplayContainer | null = null
  let adsLoader: ImaAdsLoader | null = null
  let adsManager: ImaAdsManager | null = null

  let status: PreRollStatus = 'loading'
  let initialized = false
  let gestureSeen = false
  let disposed = false
  let watchdog: ReturnType<typeof setTimeout> | null = null

  function viewMode(): string {
    if (!sdk) return ''
    return document.fullscreenElement ? sdk.ViewMode.FULLSCREEN : sdk.ViewMode.NORMAL
  }

  function playerSize(): { width: number; height: number } {
    const rect = adContainer.getBoundingClientRect()
    // Fall back to the video's intrinsic box if the overlay is display:none at
    // the moment IMA asks — a zero-sized ad container renders nothing.
    return {
      width: Math.round(rect.width) || video.clientWidth || 640,
      height: Math.round(rect.height) || video.clientHeight || 360,
    }
  }

  function initializeDisplayContainer(): void {
    if (initialized || !displayContainer) return
    initialized = true
    try {
      displayContainer.initialize()
    } catch {
      /* already initialised, or the SDK is unhappy — the ad simply plays muted */
    }
  }

  function clearWatchdog(): void {
    if (watchdog === null) return
    clearTimeout(watchdog)
    watchdog = null
  }

  /** Single exit for every ending. Content resumes before the caller is told. */
  function finish(outcome: PreRollOutcome): void {
    if (status === 'finished') return

    /**
     * Only a break that actually took the screen gets to give it back. An ad
     * error can arrive after the manager loaded but before the viewer has
     * pressed anything, and resuming there would start the video by itself —
     * an autoplay nobody asked for, caused by an ad failing.
     */
    const tookOver = status === 'playing'

    status = 'finished'
    clearWatchdog()

    try {
      adsManager?.destroy()
    } catch {
      /* nothing left to do about it */
    }
    adsManager = null

    if (disposed) return

    if (tookOver) {
      // Resuming before the callback keeps the video moving even if the React
      // update that hides the overlay is somehow delayed.
      void video.play().catch(() => {})
      options.onBreakEnd(outcome)
    }
  }

  function onAdsManagerLoaded(event: ImaEvent): void {
    if (disposed || !sdk || !event.getAdsManager) return

    const settings = new sdk.AdsRenderingSettings()
    settings.restoreCustomPlaybackStateOnAdBreakComplete = true
    // Fetch the creative during the request rather than after `start()`, which
    // is most of the gap between pressing play and seeing anything.
    settings.enablePreloading = true
    // Shorter than IMA's 8s default, and shorter than the break watchdog below
    // so IMA gets to fail first and report why.
    settings.loadVideoTimeout = AD_START_TIMEOUT_MS - 1000

    let manager: ImaAdsManager
    try {
      manager = event.getAdsManager(video, settings)
    } catch {
      status = 'unavailable'
      return
    }

    const adEvents = sdk.AdEvent.Type

    manager.addEventListener(adEvents.STARTED, () => {
      clearWatchdog()
      if (!disposed) options.onAdStarted()
    })
    manager.addEventListener(adEvents.SKIPPED, () => finish('skipped'))
    manager.addEventListener(adEvents.COMPLETE, () => finish('complete'))
    // Either of these means IMA is handing the screen back.
    manager.addEventListener(adEvents.ALL_ADS_COMPLETED, () => finish('complete'))
    manager.addEventListener(adEvents.CONTENT_RESUME_REQUESTED, () => finish('complete'))
    manager.addEventListener(sdk.AdErrorEvent.Type.AD_ERROR, () => finish('error'))

    adsManager = manager
    status = 'ready'
  }

  void loadImaSdk().then((ima) => {
    if (disposed) return

    // Blocked, null-routed, or simply absent. Nothing above this ever waits on
    // it, so there is nothing to unwind.
    if (!ima) {
      status = 'unavailable'
      return
    }

    sdk = ima

    try {
      /**
       * Keep IMA off the content element.
       *
       * "Custom playback" is IMA reusing the publisher's <video> to play the
       * creative, which on an hls.js player means overwriting the element's
       * `src` out from under an attached MediaSource. hls.js does not recover
       * from that, so the ad plays and the episode never comes back.
       */
      ima.settings.setDisableCustomPlaybackForIOS10Plus(true)
      ima.settings.setLocale('en')

      displayContainer = new ima.AdDisplayContainer(adContainer, video)
      if (gestureSeen) initializeDisplayContainer()

      const loader = new ima.AdsLoader(displayContainer)
      loader.addEventListener(ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, onAdsManagerLoaded)
      loader.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, () => {
        // No fill, a malformed tag, a wrapper that never unwrapped. All of them
        // mean the same thing from here: this playback has no pre-roll.
        if (status === 'loading') status = 'unavailable'
        else finish('error')
      })

      const request = new ima.AdsRequest()
      request.adTagUrl = tagUrl

      const { width, height } = playerSize()
      request.linearAdSlotWidth = width
      request.linearAdSlotHeight = height
      request.nonLinearAdSlotWidth = width
      // Overlays are capped to the bottom third of the frame (plan §9 lists
      // them as "use sparingly"), so the tag is told what will actually fit.
      request.nonLinearAdSlotHeight = Math.round(height / 3)

      // The break is always the viewer's own play, never an autostart, and the
      // creative inherits the volume they chose. Both are what keeps this the
      // right side of the Better Ads no-autoplay-with-sound rule.
      request.setAdWillAutoPlay(false)
      request.setAdWillPlayMuted(video.muted || video.volume === 0)

      loader.requestAds(request)
      adsLoader = loader
    } catch {
      status = 'unavailable'
    }
  })

  return {
    status: () => status,

    primeForGesture() {
      gestureSeen = true
      initializeDisplayContainer()
    },

    tryStart() {
      if (status !== 'ready' || !adsManager || !sdk) return false

      status = 'playing'
      video.pause()
      options.onBreakStart()

      initializeDisplayContainer()

      try {
        const { width, height } = playerSize()
        adsManager.init(width, height, viewMode())
        adsManager.setVolume(video.muted ? 0 : video.volume)
        adsManager.start()
      } catch {
        finish('error')
        return true
      }

      /**
       * The backstop for everything IMA does not report: a creative that
       * neither renders nor errors, a tag that stalls mid-redirect, an SDK left
       * wedged by an extension. Six seconds of a blank player is already too
       * long; there is no version of this where waiting more is better.
       */
      watchdog = setTimeout(() => finish('timeout'), AD_START_TIMEOUT_MS)
      return true
    },

    remainingSec() {
      if (status !== 'playing' || !adsManager) return null
      const remaining = adsManager.getRemainingTime()
      return Number.isFinite(remaining) && remaining >= 0 ? remaining : null
    },

    syncVolume() {
      if (!adsManager) return
      try {
        adsManager.setVolume(video.muted ? 0 : video.volume)
      } catch {
        /* manager torn down between the event and this call */
      }
    },

    resize() {
      if (status !== 'playing' || !adsManager) return
      try {
        const { width, height } = playerSize()
        adsManager.resize(width, height, viewMode())
      } catch {
        /* same */
      }
    },

    destroy() {
      disposed = true
      clearWatchdog()

      try {
        adsManager?.destroy()
        // Tells IMA no post-roll is coming, so it stops waiting for one.
        adsLoader?.contentComplete()
        adsLoader?.destroy()
        displayContainer?.destroy()
      } catch {
        /* teardown is best-effort; the page is going away regardless */
      }

      adsManager = null
      adsLoader = null
      displayContainer = null
      status = 'finished'
    },
  }
}
