'use client'

import type Hls from 'hls.js'
import type { Level } from 'hls.js'
import { useCallback, useEffect, useRef, useState } from 'react'

import { getPosition, savePosition } from '@/lib/player/resume'

/**
 * hls.js lifecycle, quality levels, and error recovery.
 *
 * Two playback paths, because no single one works everywhere:
 *
 *   - MSE via hls.js wherever supported. This is the path that gives a manual
 *     quality selector, ABR tuning, and buffer control.
 *   - Native HLS otherwise, which in practice means iOS Safari. It plays the
 *     same master playlist but exposes no level control, so the quality menu is
 *     hidden rather than shown broken.
 */

export type QualityLevel = {
  index: number
  height: number
  bitrateKbps: number
  label: string
}

export type PlayerState = {
  ready: boolean
  playing: boolean
  buffering: boolean
  currentTime: number
  duration: number
  muted: boolean
  volume: number
  playbackRate: number
  levels: QualityLevel[]
  /** -1 means automatic. */
  currentLevel: number
  autoLevel: boolean
  activeHeight: number | null
  error: string | null
  canSelectQuality: boolean
}

/**
 * Where ABR starts.
 *
 * Plan §8: open around 480p and let ABR climb. Starting at the top rung on an
 * Indian mobile connection guarantees a spinner before the first frame, and
 * time-to-first-frame decides whether a streaming site feels fast or broken.
 */
const START_HEIGHT = 480

/**
 * First-guess bandwidth, before any segment has been measured. hls.js defaults
 * to 500 kbps; 1.5 Mbps matches a typical Indian 4G connection without being
 * optimistic enough to overshoot on the opening segment.
 */
const INITIAL_BANDWIDTH_ESTIMATE = 1_500_000

export function useHlsPlayer(masterUrl: string, videoId: string) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const resumedRef = useRef(false)

  const [state, setState] = useState<PlayerState>({
    ready: false,
    playing: false,
    buffering: true,
    currentTime: 0,
    duration: 0,
    muted: false,
    volume: 1,
    playbackRate: 1,
    levels: [],
    currentLevel: -1,
    autoLevel: true,
    activeHeight: null,
    error: null,
    canSelectQuality: false,
  })

  const patch = useCallback((next: Partial<PlayerState>) => {
    setState((prev) => ({ ...prev, ...next }))
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !masterUrl) return

    let cancelled = false
    resumedRef.current = false

    async function attach() {
      // Dynamically imported so the ~50 KB gzipped hls.js bundle never reaches
      // the homepage — only routes that mount a player pay for it (plan §8:
      // route-level code splitting).
      const { default: HlsCtor } = await import('hls.js')
      if (cancelled || !video) return

      if (HlsCtor.isSupported()) {
        const hls = new HlsCtor({
          enableWorker: true,
          lowLatencyMode: false,
          abrEwmaDefaultEstimate: INITIAL_BANDWIDTH_ESTIMATE,
          // Bounded memory on cheap Android devices, where an unbounded back
          // buffer is a real cause of tab crashes on long content.
          backBufferLength: 30,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          /**
           * Never fetch a rendition larger than the element it renders into. A
           * 1080p stream in a 360 px viewport wastes bandwidth the viewer pays
           * for and egress this platform pays for.
           */
          capLevelToPlayerSize: true,
        })

        hlsRef.current = hls

        hls.on(HlsCtor.Events.MANIFEST_PARSED, (_event, data) => {
          const levels: QualityLevel[] = data.levels.map((level: Level, index: number) => ({
            index,
            height: level.height ?? 0,
            bitrateKbps: Math.round((level.bitrate ?? 0) / 1000),
            label: level.height ? `${level.height}p` : `${Math.round((level.bitrate ?? 0) / 1000)}k`,
          }))

          // Start at the rung nearest 480p rather than the ABR default.
          const startIndex = nearestLevel(levels, START_HEIGHT)
          if (startIndex >= 0) hls.startLevel = startIndex

          patch({ levels, ready: true, canSelectQuality: true })
        })

        hls.on(HlsCtor.Events.LEVEL_SWITCHED, (_event, data) => {
          patch({
            activeHeight: hls.levels[data.level]?.height ?? null,
            autoLevel: hls.autoLevelEnabled,
          })
        })

        hls.on(HlsCtor.Events.ERROR, (_event, data) => {
          if (!data.fatal) return

          // hls.js recovers from most fatal network and media errors by
          // restarting the relevant part of the pipeline. Destroying on the
          // first fatal error would end playback over a single bad segment.
          switch (data.type) {
            case HlsCtor.ErrorTypes.NETWORK_ERROR:
              hls.startLoad()
              break
            case HlsCtor.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError()
              break
            default:
              hls.destroy()
              patch({ error: 'This video could not be played.', ready: false })
          }
        })

        hls.loadSource(masterUrl)
        hls.attachMedia(video)
        return
      }

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // iOS Safari. Native HLS exposes no level control, so the quality menu
        // stays hidden rather than rendering a control that does nothing.
        video.src = masterUrl
        patch({ ready: true, canSelectQuality: false })
        return
      }

      patch({ error: 'HLS playback is not supported in this browser.' })
    }

    void attach()

    return () => {
      cancelled = true
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [masterUrl, patch])

  // --- Media element events --------------------------------------------------
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onLoadedMetadata = () => {
      patch({ duration: video.duration })

      // Resume once per source, after metadata makes seeking possible.
      if (!resumedRef.current) {
        resumedRef.current = true
        const saved = getPosition(videoId)
        if (saved && saved < video.duration - 5) video.currentTime = saved
      }
    }

    const onTimeUpdate = () => patch({ currentTime: video.currentTime })
    const onPlay = () => patch({ playing: true })
    const onPause = () => patch({ playing: false })
    const onWaiting = () => patch({ buffering: true })
    const onPlaying = () => patch({ buffering: false, playing: true })
    const onVolumeChange = () => patch({ muted: video.muted, volume: video.volume })
    const onRateChange = () => patch({ playbackRate: video.playbackRate })
    const onEnded = () => patch({ playing: false })

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('ratechange', onRateChange)
    video.addEventListener('ended', onEnded)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('ratechange', onRateChange)
      video.removeEventListener('ended', onEnded)
    }
  }, [patch, videoId])

  // --- Persist resume position ----------------------------------------------
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    // Every 5s rather than on every `timeupdate`, which fires ~4x a second and
    // would mean hundreds of localStorage writes per minute.
    const interval = setInterval(() => {
      if (!video.paused && video.duration > 0) {
        savePosition(videoId, video.currentTime, video.duration)
      }
    }, 5000)

    // Closing the tab mid-video is the common case, and the interval will not
    // have fired since the last tick.
    const flush = () => {
      if (video.duration > 0) savePosition(videoId, video.currentTime, video.duration)
    }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [videoId])

  // --- Controls --------------------------------------------------------------
  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }, [])

  const seek = useCallback((time: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration)) return
    video.currentTime = Math.max(0, Math.min(time, video.duration))
  }, [])

  const skip = useCallback((delta: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration)) return
    video.currentTime = Math.max(0, Math.min(video.currentTime + delta, video.duration))
  }, [])

  const setVolume = useCallback((value: number) => {
    const video = videoRef.current
    if (!video) return
    video.volume = Math.max(0, Math.min(1, value))
    if (video.volume > 0) video.muted = false
  }, [])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (video) video.muted = !video.muted
  }, [])

  const setPlaybackRate = useCallback((rate: number) => {
    const video = videoRef.current
    if (video) video.playbackRate = rate
  }, [])

  const setLevel = useCallback((index: number) => {
    const hls = hlsRef.current
    if (!hls) return
    // -1 restores automatic selection.
    hls.currentLevel = index
    setState((prev) => ({ ...prev, currentLevel: index, autoLevel: index === -1 }))
  }, [])

  return {
    videoRef,
    state,
    controls: { togglePlay, seek, skip, setVolume, toggleMute, setPlaybackRate, setLevel },
  }
}

function nearestLevel(levels: QualityLevel[], targetHeight: number): number {
  if (levels.length === 0) return -1

  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY

  for (const level of levels) {
    const distance = Math.abs(level.height - targetHeight)
    if (distance < bestDistance) {
      bestDistance = distance
      best = level.index
    }
  }

  return best
}
