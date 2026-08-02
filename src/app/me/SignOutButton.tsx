'use client'

import { useState } from 'react'

/**
 * Sign-out button for the account dashboard.
 *
 * Lives on /me rather than the header avatar (the previous behaviour was
 * the header avatar signing you out with no confirmation — surprising UX).
 * The DELETE hits /api/auth/login which deletes the session row and clears
 * the cookie, then a full navigation back to '/' so no stale server-component
 * tree remains.
 */
export function SignOutButton() {
  const [pending, setPending] = useState(false)

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        try {
          await fetch('/api/auth/login', {
            method: 'DELETE',
            credentials: 'same-origin',
          })
        } finally {
          window.location.href = '/'
        }
      }}
      className="ml-auto rounded-full bg-surface px-5 py-2 text-sm font-bold text-ink ring-1 ring-line transition hover:bg-mist disabled:opacity-50"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
