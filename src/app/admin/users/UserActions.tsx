'use client'

import { useState } from 'react'

import { button, field } from '../ui'

const ROLES = ['viewer', 'creator', 'moderator', 'admin'] as const

/**
 * Per-row user controls.
 *
 * Two commands live here: a role `<select>` that PATCHes the new role, and a
 * Delete button that soft-deletes (nulls PII, keeps the row). Deleted rows
 * show a single Restore button instead. The list is server-rendered, so every
 * successful action reloads the page rather than reconciling state in place.
 *
 * The last-admin guard is enforced by the API; on a 409 `last_admin` we
 * surface "Last admin cannot be demoted" and do nothing — the select snaps
 * back on reload, so the operator cannot talk themselves into a lockout.
 */
export function UserActions({ userId, role, deleted }: { userId: string; role: string; deleted: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function patchRole(next: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ role: next }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        if (body.error === 'last_admin') {
          setError('Last admin cannot be demoted')
        } else {
          setError(body.error ?? 'failed')
        }
        return
      }
      window.location.reload()
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm('Soft-delete this user? PII will be nulled; the row stays for audit.')) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        if (body.error === 'last_admin') {
          setError('Last admin cannot be deleted')
        } else {
          setError(body.error ?? 'failed')
        }
        return
      }
      window.location.reload()
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  async function restore() {
    const email = window.prompt(
      'Restoring a deleted user requires a new email address (the previous one was erased on delete).',
      '',
    )
    if (email === null) return
    const trimmed = email.trim()
    if (!trimmed) {
      setError('an email is required to restore')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: trimmed }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? 'failed')
        return
      }
      window.location.reload()
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  if (deleted) {
    return (
      <div className="flex items-center gap-2">
        {error ? <span className="text-xs font-bold text-primary">{error}</span> : null}
        <button type="button" className={button.tiny} disabled={busy} onClick={restore}>
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {error ? <span className="text-xs font-bold text-primary">{error}</span> : null}
      <select
        value={role}
        disabled={busy}
        onChange={(e) => patchRole(e.target.value)}
        className={`${field} w-auto py-1 px-2 text-xs`}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button type="button" className={button.tiny} disabled={busy} onClick={remove}>
        {busy ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  )
}
