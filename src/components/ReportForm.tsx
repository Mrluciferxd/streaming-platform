'use client'

import { useState } from 'react'

import { button } from '@/app/admin/ui'

const REASONS = [
  { value: 'wrong_classification', label: 'Wrong content classification' },
  { value: 'breaches_code_of_ethics', label: 'Breaches the Code of Ethics' },
  { value: 'accessibility', label: 'Accessibility problem' },
  { value: 'privacy_complaint', label: 'Privacy / personal data complaint' },
  { value: 'copyright', label: 'Copyright infringement' },
  { value: 'other', label: 'Other' },
] as const

/**
 * Public grievance intake form.
 *
 * The IT Rules 2021 mechanism is open — the Grievance Officer cannot refuse a
 * complaint for want of an account. So this form is unauthenticated: a
 * signed-out filer leaves an email (the Officer needs a way back to them); a
 * signed-in filer's id is recorded by the API and the email field is hidden.
 *
 * The form POSTs to /api/reports. Success replaces the form with an
 * acknowledgement carrying the report id — the Rules require acknowledgement
 * within 24 hours, and immediate is better than 24.
 *
 * `videoId` and `commentId` are optional; the watch page and a comment's
 * "report" button can pass them as hidden fields. A general complaint leaves
 * both blank.
 */
export function ReportForm({ videoId, commentId }: { videoId?: string; commentId?: string }) {
  const [reason, setReason] = useState<string>('')
  const [detail, setDetail] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filedId, setFiledId] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)

    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          videoId: videoId ?? null,
          commentId: commentId ?? null,
          reason,
          detail,
          reporterEmail: email || null,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
      if (!res.ok) {
        setError(body.error ?? 'failed')
        return
      }
      if (body.id) setFiledId(body.id)
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  if (filedId) {
    return (
      <div className="mt-6 rounded-2xl bg-accent-soft p-5 text-sm">
        <p className="font-bold text-accent">Your complaint has been filed.</p>
        <p className="mt-1 text-ink-soft">
          Reference: <span className="font-mono">{filedId}</span>
        </p>
        <p className="mt-1 text-xs text-muted">
          It will be acknowledged within 24 hours and resolved within 15 days, as the IT Rules 2021 require.
          Keep this reference if you need to follow up.
        </p>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="mt-6 rounded-2xl bg-surface p-5 ring-1 ring-line"
      aria-label="File a grievance"
    >
      <h3 className="font-display text-base font-extrabold tracking-tight">File a complaint</h3>
      <p className="mt-1 text-xs text-muted">
        You do not need an account to file. A reply channel helps the Officer reach you.
      </p>

      {videoId ? <input type="hidden" name="videoId" value={videoId} /> : null}
      {commentId ? <input type="hidden" name="commentId" value={commentId} /> : null}

      <label className="mb-1 mt-4 block text-xs font-bold text-ink">Reason</label>
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        disabled={busy}
        className="w-full rounded-xl bg-mist px-3 py-2 text-sm outline-none ring-primary/40 focus:ring-2 disabled:opacity-50"
      >
        <option value="" disabled>
          Select a reason…
        </option>
        {REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>

      <label className="mb-1 mt-4 block text-xs font-bold text-ink">Detail</label>
      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        required
        disabled={busy}
        rows={5}
        maxLength={20_000}
        placeholder="What happened, where, and what outcome you are asking for…"
        className="w-full rounded-xl bg-mist px-3 py-2 text-sm outline-none ring-primary/40 focus:ring-2 disabled:opacity-50"
      />

      <label className="mb-1 mt-4 block text-xs font-bold text-ink">
        Email <span className="font-medium text-muted">(optional, for anonymous filers)</span>
      </label>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
        maxLength={320}
        placeholder="you@example.com"
        className="w-full rounded-xl bg-mist px-3 py-2 text-sm outline-none ring-primary/40 focus:ring-2 disabled:opacity-50"
      />

      {error ? <p className="mt-2 text-xs font-bold text-primary">{error}</p> : null}

      <button type="submit" className={`${button.primary} mt-4`} disabled={busy || !reason || !detail.trim()}>
        {busy ? 'Filing…' : 'File complaint'}
      </button>
    </form>
  )
}
