'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import type { CommentRow } from '@/lib/queries/comments'

/**
 * Per-video comment thread, one level deep.
 *
 * The list hydrates from the API on mount (so a public page's HTML can be
 * cached server-side without per-viewer comment state baked in). Posting is
 * optimistic: the new comment is inserted into the local tree immediately
 * with author "You", and a failure rolls it back. Reply branches attach to
 * a single expanded top-level at a time — a reply box per comment would
 * push the thread into a wall of inputs.
 */
export function Comments({ videoId }: { videoId: string }) {
  const router = useRouter()
  const [items, setItems] = useState<CommentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const res = await fetch(`/api/comments?videoId=${encodeURIComponent(videoId)}`, { credentials: 'same-origin' })
    if (!res.ok) return
    const data = (await res.json()) as { items: CommentRow[] }
    setItems(data.items ?? [])
    setLoading(false)
  }

  useEffect(() => {
    refresh().catch(() => setLoading(false))
  }, [videoId])

  async function submit(body: string, parentId: string | null) {
    setError(null)
    setPending(true)
    // Optimistic insert
    const optimistic: CommentRow = {
      id: `pending-${Date.now()}`,
      videoId,
      body,
      createdAt: new Date(),
      authorDisplayName: 'You',
      authorRole: 'viewer',
      replies: [],
    }
    if (parentId) {
      setItems((prev) =>
        prev.map((t) =>
          t.id === parentId ? { ...t, replies: [...t.replies, optimistic] } : t,
        ),
      )
    } else {
      setItems((prev) => [optimistic, ...prev])
    }
    setReplyTo(null)

    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ videoId, body, parentId }),
      })
      if (res.status === 401) {
        // Roll back the optimistic row, then show the door to /account so
        // the viewer returns here after auth — same pattern as Reactions.
        await refresh()
        router.push('/account?next=' + encodeURIComponent(window.location.pathname))
        return
      }
      if (!res.ok) throw new Error('failed')
      await refresh()
    } catch {
      setError('Could not post that comment. Try again.')
      // Roll back by refreshing, which discards the optimistic row.
      await refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="mt-10">
      <h2 className="font-display text-lg font-extrabold tracking-tight">
        Comments {items.length > 0 ? `· ${items.length}` : ''}
      </h2>

      <CommentBox
        key="root"
        disabled={pending}
        placeholder="Share your thoughts…"
        onSubmit={(body) => submit(body, null)}
      />

      {error ? (
        <p className="mt-2 text-sm font-semibold text-red">{error}</p>
      ) : null}

      {loading ? (
        <p className="mt-6 text-sm text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-6 text-sm text-muted">No comments yet. Be the first.</p>
      ) : (
        <ul className="mt-6 space-y-5">
          {items.map((c) => (
            <li key={c.id}>
              <CommentView comment={c} onReply={() => setReplyTo(replyTo === c.id ? null : c.id)} />
              {replyTo === c.id ? (
                <div className="mt-3 pl-12">
                  <CommentBox
                    key={`reply-${c.id}`}
                    disabled={pending}
                    placeholder={`Reply to ${c.authorDisplayName}…`}
                    onSubmit={(body) => submit(body, c.id)}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}
                  className="mt-2 pl-12 text-xs font-bold text-ink-soft transition hover:text-primary"
                >
                  Reply
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CommentView({ comment, onReply }: { comment: CommentRow; onReply: () => void }) {
  return (
    <article className="flex gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary text-xs font-extrabold text-white">
        {comment.authorDisplayName.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-bold text-ink">{comment.authorDisplayName}</span>
          {comment.authorRole !== 'viewer' ? (
            <span className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-primary">
              {comment.authorRole}
            </span>
          ) : null}
          <span className="text-xs text-muted">{formatRelative(comment.createdAt)}</span>
        </div>
        <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-soft">
          {comment.body}
        </p>
        {comment.replies.length > 0 ? (
          <ul className="mt-4 space-y-4 border-l-2 border-line pl-4">
            {comment.replies.map((r) => (
              <li key={r.id}>
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-bold text-ink">{r.authorDisplayName}</span>
                  {r.authorRole !== 'viewer' ? (
                    <span className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-primary">
                      {r.authorRole}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted">{formatRelative(r.createdAt)}</span>
                </div>
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-soft">
                  {r.body}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  )
}

function CommentBox({
  disabled,
  placeholder,
  onSubmit,
}: {
  disabled: boolean
  placeholder: string
  onSubmit: (body: string) => void
}) {
  const [body, setBody] = useState('')

  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = body.trim()
        if (!trimmed || disabled) return
        onSubmit(trimmed)
        setBody('')
      }}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        rows={3}
        maxLength={20_000}
        className="w-full rounded-xl bg-mist px-4 py-2.5 text-sm outline-none ring-primary/40 placeholder:text-muted focus:ring-2 disabled:opacity-50"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="submit"
          disabled={disabled || !body.trim()}
          className="rounded-full bg-primary px-5 py-2 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
        >
          {disabled ? 'Posting…' : 'Post'}
        </button>
      </div>
    </form>
  )
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - new Date(d).getTime()
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
