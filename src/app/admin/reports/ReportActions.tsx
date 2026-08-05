'use client'

import { useState } from 'react'

import { button } from '../ui'

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-mist text-ink-soft',
  reviewing: 'bg-secondary-soft text-secondary',
  actioned: 'bg-accent-soft text-accent',
  dismissed: 'bg-primary-soft text-primary',
  overdue: 'bg-primary text-white',
}

/**
 * Per-report triage controls.
 *
 * Status graph: open -> reviewing -> (actioned | dismissed); reopen returns a
 * terminal report to open. The note modal is inline because the page is a
 * server-rendered list and a separate route for one form is overkill — the
 * entire control is client, so no navigation on action.
 */
export function ReportActions({ reportId, status }: { reportId: string; status: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noteOpen, setNoteOpen] = useState<null | 'action' | 'dismiss'>(null)
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState<string | null>(null)

  const terminal = status === 'actioned' || status === 'dismissed'

  async function post(action: string, payload: Record<string, unknown> = {}) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/reports/${reportId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, ...payload }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? 'failed')
        return false
      }
      setConfirmed(action)
      // The page is server-rendered; refresh to show the new status.
      window.location.reload()
      return true
    } catch {
      setError('failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submitNote() {
    const trimmed = note.trim()
    if (trimmed.length < 3) {
      setError('note_too_short')
      return
    }
    const ok = await post(noteOpen ?? '', { note: trimmed })
    if (ok) {
      setNoteOpen(null)
      setNote('')
    }
  }

  return (
    <div className="mt-3">
      {error ? <p className="mb-2 text-xs font-bold text-primary">{error}</p> : null}
      {confirmed && terminal ? (
        <p className="text-xs font-bold text-accent">Marked {confirmed}. Reloading…</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
            STATUS_STYLE[status] ?? 'bg-mist text-ink-soft'
          }`}
        >
          {status}
        </span>

        {status === 'open' ? (
          <button type="button" className={button.tiny} disabled={busy} onClick={() => post('review')}>
            Mark reviewing
          </button>
        ) : null}

        {!terminal ? (
          <>
            <button
              type="button"
              className={button.tiny}
              disabled={busy}
              onClick={() => {
                setError(null)
                setNoteOpen('action')
              }}
            >
              Action
            </button>
            <button
              type="button"
              className={button.tiny}
              disabled={busy}
              onClick={() => {
                setError(null)
                setNoteOpen('dismiss')
              }}
            >
              Dismiss
            </button>
          </>
        ) : (
          <button type="button" className={button.tiny} disabled={busy} onClick={() => post('reopen')}>
            Reopen
          </button>
        )}
      </div>

      {noteOpen ? (
        <div className="mt-2 rounded-xl bg-mist p-3">
          <label className="mb-1 block text-xs font-bold text-ink">
            Resolution note<span className="font-medium text-muted"> — required, becomes the record</span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={3}
            maxLength={20_000}
            className="w-full rounded-xl bg-surface px-3 py-2 text-sm outline-none ring-primary/40 focus:ring-2 disabled:opacity-50"
            placeholder="What was done, and why…"
          />
          <div className="mt-2 flex gap-2">
            <button type="button" className={button.primary} disabled={busy} onClick={submitNote}>
              {busy ? 'Saving…' : `Confirm ${noteOpen}`}
            </button>
            <button
              type="button"
              className={button.ghost}
              disabled={busy}
              onClick={() => {
                setNoteOpen(null)
                setNote('')
                setError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
