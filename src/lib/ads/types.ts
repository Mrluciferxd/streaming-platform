/**
 * Structural types for the two Google SDKs this directory drives.
 *
 * Both are loaded at runtime from Google's origin and neither ships types, so
 * the alternative is a DefinitelyTyped dependency whose only job is to describe
 * a script we never bundle. Hand-writing the members actually used keeps the
 * dependency list honest and makes the integration surface reviewable in one
 * file: if a member is not declared here, no code in `src/lib/ads` touches it.
 */

// --- Google IMA (VAST/VMAP video ads) ---------------------------------------

export interface ImaAd {
  getAdId(): string
  getDuration(): number
  getTitle(): string | null
  isLinear(): boolean
  getSkipTimeOffset(): number
}

export interface ImaAdError {
  getErrorCode(): number
  getMessage(): string
}

/**
 * One shape for every IMA event.
 *
 * IMA dispatches by string type, so nothing at the call site knows statically
 * which concrete event class arrives — `AdEvent`, `AdErrorEvent` and
 * `AdsManagerLoadedEvent` all land in the same `addEventListener`. Optional
 * members model that honestly and force each handler to probe for what it
 * needs, which is what the runtime requires anyway.
 */
export interface ImaEvent {
  type: string
  /** AdEvent only. */
  getAd?(): ImaAd | null
  /** AdErrorEvent only. */
  getError?(): ImaAdError
  /** AdsManagerLoadedEvent only. */
  getAdsManager?(
    contentPlayback: HTMLVideoElement | null,
    settings?: ImaAdsRenderingSettings,
  ): ImaAdsManager
}

export interface ImaAdsRequest {
  adTagUrl: string
  linearAdSlotWidth: number
  linearAdSlotHeight: number
  nonLinearAdSlotWidth: number
  nonLinearAdSlotHeight: number
  setAdWillAutoPlay(willAutoPlay: boolean): void
  setAdWillPlayMuted(willPlayMuted: boolean): void
  setContinuousPlayback(continuous: boolean): void
}

export interface ImaAdsRenderingSettings {
  restoreCustomPlaybackStateOnAdBreakComplete: boolean
  enablePreloading: boolean
  /** Milliseconds IMA waits for a creative before giving up on it. */
  loadVideoTimeout: number
}

export interface ImaAdDisplayContainer {
  initialize(): void
  destroy(): void
}

export interface ImaAdsLoader {
  addEventListener(type: string, handler: (event: ImaEvent) => void): void
  requestAds(request: ImaAdsRequest): void
  contentComplete(): void
  destroy(): void
}

export interface ImaAdsManager {
  init(width: number, height: number, viewMode: string): void
  start(): void
  stop(): void
  destroy(): void
  resize(width: number, height: number, viewMode: string): void
  setVolume(volume: number): void
  getRemainingTime(): number
  addEventListener(type: string, handler: (event: ImaEvent) => void): void
}

export interface ImaSdk {
  settings: {
    setLocale(locale: string): void
    /**
     * True keeps IMA off the content <video> element. See the comment in
     * AdController — this is load-bearing for an hls.js player.
     */
    setDisableCustomPlaybackForIOS10Plus(disable: boolean): void
    setPlayerType(type: string): void
    setPlayerVersion(version: string): void
  }
  AdDisplayContainer: new (
    container: HTMLElement,
    video?: HTMLVideoElement | null,
  ) => ImaAdDisplayContainer
  AdsLoader: new (container: ImaAdDisplayContainer) => ImaAdsLoader
  AdsRequest: new () => ImaAdsRequest
  AdsRenderingSettings: new () => ImaAdsRenderingSettings
  AdEvent: {
    Type: {
      LOADED: string
      STARTED: string
      COMPLETE: string
      SKIPPED: string
      ALL_ADS_COMPLETED: string
      CONTENT_PAUSE_REQUESTED: string
      CONTENT_RESUME_REQUESTED: string
    }
  }
  AdErrorEvent: { Type: { AD_ERROR: string } }
  AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: string } }
  ViewMode: { NORMAL: string; FULLSCREEN: string }
}

// --- Google Publisher Tag (display) -----------------------------------------

/** Opaque to us — built by GPT and handed straight back to it. */
export type GptSizeMapping = { readonly __gptSizeMapping: unique symbol }

export type GptSize = [number, number]

export interface GptSlot {
  addService(service: GptPubAdsService): GptSlot
  defineSizeMapping(mapping: GptSizeMapping): GptSlot
  setCollapseEmptyDiv(collapse: boolean, collapseBeforeAdFetch?: boolean): GptSlot
  getSlotElementId(): string
}

export interface GptSlotRenderEvent {
  isEmpty: boolean
  slot: GptSlot
}

export interface GptPubAdsService {
  enableSingleRequest(): void
  collapseEmptyDivs(collapse: boolean): void
  setForceSafeFrame(force: boolean): void
  setCentering(centering: boolean): void
  addEventListener(type: string, handler: (event: GptSlotRenderEvent) => void): void
  removeEventListener(type: string, handler: (event: GptSlotRenderEvent) => void): void
}

export interface GptSizeMappingBuilder {
  addSize(viewport: GptSize, sizes: GptSize[]): GptSizeMappingBuilder
  build(): GptSizeMapping
}

export interface Googletag {
  cmd: { push(callback: () => void): void }
  defineSlot(adUnitPath: string, sizes: GptSize[], elementId: string): GptSlot | null
  sizeMapping(): GptSizeMappingBuilder
  pubads(): GptPubAdsService
  enableServices(): void
  display(slot: GptSlot | string): void
  destroySlots(slots?: GptSlot[]): boolean
}

declare global {
  interface Window {
    google?: { ima?: ImaSdk }
    googletag?: Googletag
  }
}
