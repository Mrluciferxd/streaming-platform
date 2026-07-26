'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/**
 * Add / remove from the viewer's list.
 *
 * Optimistic: the icon flips immediately and rolls back if the request fails.
 * The round trip is ~200 ms on an Indian mobile connection, and a button that
 * visibly lags behind the tap reads as broken.
 *
 * Signed-out viewers are sent to the account page with a `next` back to where
 * they were, rather than being shown a disabled control — the list is the main
 * reason to create an account, so this is the moment to ask.
 */
export function MyListButton({
  videoId,
  initiallyInList,
  signedIn,
  returnTo,
  variant = 'pill',
}: {
  videoId: string
  initiallyInList: boolean
  signedIn: boolean
  returnTo: string
  variant?: 'pill' | 'icon'
}) {
  const router = useRouter()
  const [inList, setInList] = useState(initiallyInList)
  const [pending, setPending] = useState(false)

  async function toggle() {
    if (!signedIn) {
      router.push(`/account?next=${encodeURIComponent(returnTo)}`)
      return
    }

    const next = !inList
    setInList(next)
    setPending(true)

    try {
      const response = await fetch('/api/watchlist', {
        method: next ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId }),
        credentials: 'same-origin',
      })
      if (!response.ok) setInList(!next)
    } catch {
      setInList(!next)
    } finally {
      setPending(false)
    }
  }

  const label = inList ? 'Remove from My List' : 'Add to My List'

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-label={label}
        title={label}
        aria-pressed={inList}
        className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white/70 bg-black/30 text-white backdrop-blur transition hover:bg-black/50 disabled:opacity-60"
      >
        <Glyph inList={inList} className="h-4 w-4" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={inList}
      className="flex items-center gap-2 rounded-full bg-mist px-7 py-3 text-sm font-bold text-ink transition hover:bg-secondary-soft disabled:opacity-60 sm:text-base"
    >
      <Glyph inList={inList} className="h-4 w-4" />
      {inList ? 'In My List' : 'My List'}
    </button>
  )
}

function Glyph({ inList, className }: { inList: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {inList ? <path d="M20 6L9 17l-5-5" /> : <path d="M12 5v14M5 12h14" />}
    </svg>
  )
}
