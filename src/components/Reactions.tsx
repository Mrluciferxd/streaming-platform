'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import type { ReactionType } from '@/lib/queries/reactions'

type Counts = { likes: number; dislikes: number; mine: ReactionType | null }

/**
 * Like / dislike on a title.
 *
 * Reads its own state on mount so the page can render server-side without
 * the per-viewer reaction (a public page must not block on a session lookup)
 * and the buttons fix themselves up once the client knows who is watching.
 *
 * Optimistic on click: the count and the active state flip immediately and
 * the request is fired in the background. A failure rolls back and surfaces
 * the erroring action so a transient 503 does not look like success.
 *
 * The "signed out" state is the buttons at full strength but disabled; a
 * click routes to /account so the viewer can come back to rate, rather than
 * an in-your-face modal that interrupts someone who just wants to watch.
 */
export function Reactions({ videoId }: { videoId: string }) {
  const router = useRouter()
  const [state, setState] = useState<Counts | null>(null)
  const [pending, setPending] = useState<ReactionType | null>(null)
  const [error, setError] = useState<ReactionType | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/reactions?videoId=${encodeURIComponent(videoId)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Counts | null) => {
        if (cancelled || !data) return
        setState(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [videoId])

  async function act(type: ReactionType) {
    if (pending) return

    // No session yet — show the door to the sign-in page instead of a 401
    // toast. The viewer comes back here after auth.
    if (state?.mine === undefined) {
      router.push('/account?next=' + encodeURIComponent(window.location.pathname))
      return
    }

    const before = state
    if (!before) return

    setPending(type)
    setError(null)

    // Second tap on the active type clears it. A tap on the opposite type
    // flips it. Both look like an immediate change to the viewer.
    const toggledOff = before.mine === type
    const optimistic: Counts = {
      likes:
        (before.likes ?? 0) +
        (type === 'like' ? (toggledOff ? -1 : before.mine === 'dislike' ? 1 : 1) : 0) -
        (type === 'dislike' ? (before.mine === 'like' ? 1 : 0) : 0),
      dislikes:
        (before.dislikes ?? 0) +
        (type === 'dislike' ? (toggledOff ? -1 : before.mine === 'like' ? 1 : 1) : 0) -
        (type === 'like' ? (before.mine === 'dislike' ? 1 : 0) : 0),
      mine: toggledOff ? null : type,
    }
    setState(optimistic)

    try {
      const res = await fetch(
        toggledOff
          ? `/api/reactions?videoId=${encodeURIComponent(videoId)}`
          : '/api/reactions',
        {
          method: toggledOff ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: toggledOff ? undefined : JSON.stringify({ videoId, type }),
          credentials: 'same-origin',
        },
      )
      if (!res.ok) throw new Error('failed')
      const data: Counts = await res.json()
      setState(data)
    } catch {
      // Roll back. The viewer sees a flinch and the unchanged state, which is
      // the honest outcome of a failed request.
      setState(before)
      setError(type)
    } finally {
      setPending(null)
    }
  }

  const mine = state?.mine
  const likes = state?.likes ?? 0
  const dislikes = state?.dislikes ?? 0

  // `state === null` -> still loading; treat as a signed-out viewer who can't
  // act yet (disabled), which is correct either way.
  const signedOut = state !== null && mine === null && state.mine === null

  return (
    <div className="mt-5 flex items-center gap-3">
      <ActionButton
        type="like"
        active={mine === 'like'}
        count={likes}
        pending={pending === 'like'}
        disabled={pending !== null}
        error={error === 'like' && pending === null}
        onClick={() => act('like')}
        signedOut={signedOut}
        label={likes > 0 ? formatCount(likes) : 'Like'}
      />
      <ActionButton
        type="dislike"
        active={mine === 'dislike'}
        count={dislikes}
        pending={pending === 'dislike'}
        disabled={pending !== null}
        error={error === 'dislike' && pending === null}
        onClick={() => act('dislike')}
        signedOut={signedOut}
        label={dislikes > 0 ? formatCount(dislikes) : 'Dislike'}
      />
    </div>
  )
}

function ActionButton({
  type,
  active,
  count,
  pending,
  disabled,
  error,
  onClick,
  signedOut,
  label,
}: {
  type: ReactionType
  active: boolean
  count: number
  pending: boolean
  disabled: boolean
  error: boolean
  onClick: () => void
  signedOut: boolean
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        signedOut
          ? 'Sign in to rate this title'
          : type === 'like'
            ? 'Like'
            : 'Dislike'
      }
      aria-pressed={active}
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold ring-1 transition disabled:opacity-50 ${
        active
          ? type === 'like'
            ? 'bg-primary text-white ring-primary'
            : 'bg-ink text-white ring-ink'
          : error
            ? 'bg-red-soft text-red ring-red'
            : 'bg-surface text-ink ring-line hover:bg-mist'
      }`}
    >
      {pending ? (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" strokeWidth="3" className="opacity-25" stroke="currentColor" />
          <path d="M4 12a8 8 0 0 1 8-8" strokeWidth="3" strokeLinecap="round" stroke="currentColor" />
        </svg>
      ) : type === 'like' ? (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 11v8a1 1 0 0 0 1 1h9.5a2 2 0 0 0 1.9-1.4l1.6-5a1 1 0 0 0-.95-1.3H14l1.3-4.4a1.5 1.5 0 0 0-2.4-1.5L7 11H4" />
          <path d="M7 11H4v9h3" />
        </svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 13V5a1 1 0 0 0-1-1H6.5A2 2 0 0 0 4.6 5.4l-1.6 5A1 1 0 0 0 4 11.7H10l-1.3 4.4a1.5 1.5 0 0 0 2.4 1.5L17 13h3" />
          <path d="M17 13h3V4h-3" />
        </svg>
      )}
      <span>{count > 0 ? formatCount(count) : label}</span>
    </button>
  )
}

function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`
  return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
}
