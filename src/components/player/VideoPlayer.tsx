'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { formatTime } from './formatTime'
import { SeekBar } from './SeekBar'
import { useHlsPlayer } from './useHlsPlayer'

/**
 * The watch-page player.
 *
 * Covers the plan §7 MVP list: ABR with automatic switching, manual quality
 * selection, resume, keyboard shortcuts, speed control, fullscreen,
 * picture-in-picture, scrub previews, and gesture seek on touch.
 */

type Props = {
  videoId: string
  masterUrl: string
  posterUrl: string | null
  spriteVttUrl: string | null
  title: string
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const CONTROLS_HIDE_MS = 3000

export function VideoPlayer({ videoId, masterUrl, posterUrl, spriteVttUrl, title }: Props) {
  const { videoRef, state, controls } = useHlsPlayer(masterUrl, videoId)
  const containerRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [controlsVisible, setControlsVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [menu, setMenu] = useState<'quality' | 'speed' | null>(null)
  const [bufferedEnd, setBufferedEnd] = useState(0)
  const [seekFlash, setSeekFlash] = useState<'back' | 'forward' | null>(null)

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)

    hideTimer.current = setTimeout(() => {
      // Never hide while paused or while a menu is open — a control bar that
      // vanishes mid-interaction is worse than one that lingers.
      if (state.playing && !menu) setControlsVisible(false)
    }, CONTROLS_HIDE_MS)
  }, [state.playing, menu])

  useEffect(() => {
    revealControls()
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [revealControls])

  // Buffered ranges drive the seek bar's secondary fill.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const update = () => {
      if (video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1))
      }
    }

    video.addEventListener('progress', update)
    video.addEventListener('timeupdate', update)
    return () => {
      video.removeEventListener('progress', update)
      video.removeEventListener('timeupdate', update)
    }
  }, [videoRef])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void container.requestFullscreen().catch(() => {})
  }, [])

  const togglePip = useCallback(async () => {
    const video = videoRef.current
    if (!video) return

    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    } catch {
      /* unsupported or blocked — nothing useful to show the viewer */
    }
  }, [videoRef])

  // --- Keyboard shortcuts (plan §7) -----------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // Never hijack typing in the search box.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return
      }

      const container = containerRef.current
      if (!container) return
      // Only when the player is on screen and roughly in view.
      if (!document.fullscreenElement && !container.contains(document.activeElement) && !isInView(container)) {
        return
      }

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault()
          controls.togglePlay()
          break
        case 'ArrowLeft':
          event.preventDefault()
          controls.skip(-5)
          flash('back')
          break
        case 'ArrowRight':
          event.preventDefault()
          controls.skip(5)
          flash('forward')
          break
        case 'j':
          event.preventDefault()
          controls.skip(-10)
          flash('back')
          break
        case 'l':
          event.preventDefault()
          controls.skip(10)
          flash('forward')
          break
        case 'ArrowUp':
          event.preventDefault()
          controls.setVolume(state.volume + 0.1)
          break
        case 'ArrowDown':
          event.preventDefault()
          controls.setVolume(state.volume - 0.1)
          break
        case 'f':
          event.preventDefault()
          toggleFullscreen()
          break
        case 'm':
          event.preventDefault()
          controls.toggleMute()
          break
        default:
          // 0–9 jump to that decile, as every other player does.
          if (/^[0-9]$/.test(event.key) && state.duration > 0) {
            event.preventDefault()
            controls.seek((Number(event.key) / 10) * state.duration)
          }
          return
      }

      revealControls()
    }

    function flash(direction: 'back' | 'forward') {
      setSeekFlash(direction)
      setTimeout(() => setSeekFlash(null), 400)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controls, state.volume, state.duration, toggleFullscreen, revealControls])

  // --- Touch: double-tap either side to seek --------------------------------
  const lastTap = useRef<{ time: number; side: 'back' | 'forward' } | null>(null)

  const onTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const container = containerRef.current
      const touch = event.changedTouches[0]
      if (!container || !touch) return

      const rect = container.getBoundingClientRect()
      const side: 'back' | 'forward' = touch.clientX - rect.left < rect.width / 2 ? 'back' : 'forward'
      const now = Date.now()
      const previous = lastTap.current

      if (previous && now - previous.time < 300 && previous.side === side) {
        controls.skip(side === 'back' ? -10 : 10)
        setSeekFlash(side)
        setTimeout(() => setSeekFlash(null), 400)
        lastTap.current = null
        return
      }

      lastTap.current = { time: now, side }
    },
    [controls],
  )

  if (state.error) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-neutral-900 text-sm text-neutral-300">
        {state.error}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="group/player relative aspect-video w-full overflow-hidden rounded-lg bg-black select-none"
      onPointerMove={revealControls}
      onTouchEnd={onTouchEnd}
      onClick={(event) => {
        // Ignore clicks that landed on the control bar.
        if ((event.target as HTMLElement).closest('[data-controls]')) return
        controls.togglePlay()
      }}
    >
      <video
        ref={videoRef}
        poster={posterUrl ?? undefined}
        // The player fetches its own manifest; letting the element preload the
        // poster only is what keeps time-to-first-byte off the critical path.
        preload="metadata"
        playsInline
        className="h-full w-full"
        aria-label={title}
      />

      {state.buffering && state.ready ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-3 border-white/30 border-t-white" />
        </div>
      ) : null}

      {seekFlash ? (
        <div
          className={`pointer-events-none absolute inset-y-0 flex w-1/3 items-center justify-center ${
            seekFlash === 'back' ? 'left-0' : 'right-0'
          }`}
        >
          <span className="rounded-full bg-black/60 px-4 py-2 text-sm font-medium text-white">
            {seekFlash === 'back' ? '« 10s' : '10s »'}
          </span>
        </div>
      ) : null}

      {!state.playing && state.ready ? (
        <button
          type="button"
          onClick={controls.togglePlay}
          aria-label="Play"
          className="absolute inset-0 flex items-center justify-center"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/75">
            <PlayIcon className="ml-1 h-7 w-7" />
          </span>
        </button>
      ) : null}

      <div
        data-controls
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pb-2 pt-8 transition-opacity ${
          controlsVisible || !state.playing ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <SeekBar
          currentTime={state.currentTime}
          duration={state.duration}
          bufferedEnd={bufferedEnd}
          spriteVttUrl={spriteVttUrl}
          onSeek={controls.seek}
        />

        <div className="flex items-center gap-1 text-white">
          <IconButton onClick={controls.togglePlay} label={state.playing ? 'Pause' : 'Play'}>
            {state.playing ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}
          </IconButton>

          <IconButton onClick={() => controls.skip(-10)} label="Back 10 seconds">
            <SkipBackIcon className="h-5 w-5" />
          </IconButton>
          <IconButton onClick={() => controls.skip(10)} label="Forward 10 seconds">
            <SkipForwardIcon className="h-5 w-5" />
          </IconButton>

          <div className="group/volume flex items-center">
            <IconButton onClick={controls.toggleMute} label={state.muted ? 'Unmute' : 'Mute'}>
              {state.muted || state.volume === 0 ? (
                <MuteIcon className="h-5 w-5" />
              ) : (
                <VolumeIcon className="h-5 w-5" />
              )}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.muted ? 0 : state.volume}
              onChange={(event) => controls.setVolume(Number(event.target.value))}
              aria-label="Volume"
              className="h-1 w-0 cursor-pointer appearance-none rounded-full bg-white/30 opacity-0 transition-all group-hover/volume:w-16 group-hover/volume:opacity-100 accent-white"
            />
          </div>

          <span className="ml-1 text-xs tabular-nums text-white/90">
            {formatTime(state.currentTime)} / {formatTime(state.duration)}
          </span>

          <div className="ml-auto flex items-center gap-1">
            <Menu
              open={menu === 'speed'}
              onToggle={() => setMenu(menu === 'speed' ? null : 'speed')}
              label="Playback speed"
              trigger={<span className="text-xs font-medium">{state.playbackRate}×</span>}
            >
              {SPEEDS.map((speed) => (
                <MenuItem
                  key={speed}
                  active={state.playbackRate === speed}
                  onClick={() => {
                    controls.setPlaybackRate(speed)
                    setMenu(null)
                  }}
                >
                  {speed === 1 ? 'Normal' : `${speed}×`}
                </MenuItem>
              ))}
            </Menu>

            {state.canSelectQuality && state.levels.length > 1 ? (
              <Menu
                open={menu === 'quality'}
                onToggle={() => setMenu(menu === 'quality' ? null : 'quality')}
                label="Quality"
                trigger={
                  <span className="text-xs font-medium">
                    {state.autoLevel
                      ? `Auto${state.activeHeight ? ` ${state.activeHeight}p` : ''}`
                      : `${state.activeHeight ?? ''}p`}
                  </span>
                }
              >
                <MenuItem
                  active={state.currentLevel === -1}
                  onClick={() => {
                    controls.setLevel(-1)
                    setMenu(null)
                  }}
                >
                  Auto
                </MenuItem>
                {/* Highest first, which is the order viewers expect. */}
                {[...state.levels].reverse().map((level) => (
                  <MenuItem
                    key={level.index}
                    active={state.currentLevel === level.index}
                    onClick={() => {
                      controls.setLevel(level.index)
                      setMenu(null)
                    }}
                  >
                    {level.label}
                  </MenuItem>
                ))}
              </Menu>
            ) : null}

            <IconButton onClick={togglePip} label="Picture in picture">
              <PipIcon className="h-5 w-5" />
            </IconButton>

            <IconButton onClick={toggleFullscreen} label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {fullscreen ? <ExitFullscreenIcon className="h-5 w-5" /> : <FullscreenIcon className="h-5 w-5" />}
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  )
}

function isInView(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return rect.bottom > 0 && rect.top < window.innerHeight
}

// --- Small UI pieces --------------------------------------------------------

function IconButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded p-1.5 transition hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
    >
      {children}
    </button>
  )
}

function Menu({
  open,
  onToggle,
  label,
  trigger,
  children,
}: {
  open: boolean
  onToggle: () => void
  label: string
  trigger: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        aria-expanded={open}
        title={label}
        className="rounded px-2 py-1.5 transition hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
      >
        {trigger}
      </button>
      {open ? (
        <div className="absolute right-0 bottom-full mb-2 min-w-28 overflow-hidden rounded-lg bg-neutral-900/95 py-1 shadow-xl backdrop-blur">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function MenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-white/10 ${
        active ? 'font-semibold text-white' : 'text-white/80'
      }`}
    >
      <span className="w-3">{active ? '✓' : ''}</span>
      {children}
    </button>
  )
}

// --- Icons (inline, so the player pulls in no icon library) ------------------

type IconProps = { className?: string }

const PlayIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
)

const PauseIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
  </svg>
)

const SkipBackIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M11 19l-9-7 9-7v14zM22 19l-9-7 9-7v14z" fill="currentColor" />
  </svg>
)

const SkipForwardIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M13 5l9 7-9 7V5zM2 5l9 7-9 7V5z" fill="currentColor" />
  </svg>
)

const VolumeIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
  </svg>
)

const MuteIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 9v6h4l5 5V4L7 9H3zm13 0l-1.4 1.4L16.2 12l-1.6 1.6L16 15l1.6-1.6L19.2 15l1.4-1.4L19 12l1.6-1.6L19.2 9l-1.6 1.6z" />
  </svg>
)

const PipIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" />
  </svg>
)

const FullscreenIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
)

const ExitFullscreenIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </svg>
)
