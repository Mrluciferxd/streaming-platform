'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { button, Empty, field, Label, Panel } from '../ui'

export type CategoryRow = {
  id: string
  slug: string
  name: string
  description: string | null
  icon: string | null
  videoCount: number
}

const ERRORS: Record<string, string> = {
  slug_taken: 'Another category already uses that slug.',
  slug_empty: 'That name produces an empty slug — give it an explicit one.',
  invalid_request: 'Check the name and slug.',
  not_found: 'Not found, or your session is no longer an operator session.',
}

/**
 * Category CRUD.
 *
 * Order is the point of this screen as much as the names are: `sort_order`
 * drives the header navigation and the homepage rails, so it is the difference
 * between a catalogue that leads with what you have and one that leads with
 * whatever was created first.
 */
export function CategoryManager({ initial }: { initial: CategoryRow[] }) {
  const router = useRouter()
  const [items, setItems] = useState(initial)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The server is the authority; a refresh after any mutation lands here.
  useEffect(() => setItems(initial), [initial])

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true)
    setError(null)

    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        setError(ERRORS[data.error ?? ''] ?? `Request failed (${response.status}).`)
        return false
      }

      router.refresh()
      return true
    } catch {
      setError('Could not reach the server.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= items.length) return

    const next = [...items]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)

    // Optimistic: the arrows have to feel instant, and the request rewrites the
    // whole order anyway so a failure just gets corrected by the refresh.
    setItems(next)
    await call('/api/admin/categories/reorder', 'POST', { ids: next.map((c) => c.id) })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Panel title="Categories" hint="Order here is the order on the site">
        {error ? (
          <p role="alert" className="mx-5 mt-4 rounded-xl bg-primary-soft px-3.5 py-2.5 text-xs font-semibold text-primary">
            {error}
          </p>
        ) : null}

        {items.length === 0 ? (
          <Empty>No categories yet.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((category, index) => (
              <li key={category.id} className="px-5 py-3">
                {editing === category.id ? (
                  <form
                    className="space-y-3"
                    onSubmit={async (event) => {
                      event.preventDefault()
                      const form = new FormData(event.currentTarget)
                      const ok = await call(`/api/admin/categories/${category.id}`, 'PATCH', {
                        name: String(form.get('name') ?? ''),
                        slug: String(form.get('slug') ?? ''),
                        description: String(form.get('description') ?? ''),
                        icon: String(form.get('icon') ?? ''),
                      })
                      if (ok) setEditing(null)
                    }}
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <Label>Name</Label>
                        <input name="name" defaultValue={category.name} required maxLength={120} className={field} />
                      </label>
                      <label className="block">
                        <Label hint="Changes /c/<slug>">Slug</Label>
                        <input name="slug" defaultValue={category.slug} required maxLength={120} className={field} />
                      </label>
                      <label className="block sm:col-span-2">
                        <Label>Description</Label>
                        <input
                          name="description"
                          defaultValue={category.description ?? ''}
                          maxLength={2000}
                          className={field}
                        />
                      </label>
                      <label className="block">
                        <Label hint="One emoji or short token">Icon</Label>
                        <input name="icon" defaultValue={category.icon ?? ''} maxLength={60} className={field} />
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <button type="submit" className={button.primary} disabled={busy}>
                        Save
                      </button>
                      <button type="button" className={button.ghost} onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        aria-label={`Move ${category.name} up`}
                        disabled={busy || index === 0}
                        onClick={() => void move(index, -1)}
                        className="rounded px-1.5 text-xs font-bold text-muted hover:text-primary disabled:opacity-25"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${category.name} down`}
                        disabled={busy || index === items.length - 1}
                        onClick={() => void move(index, 1)}
                        className="rounded px-1.5 text-xs font-bold text-muted hover:text-primary disabled:opacity-25"
                      >
                        ▼
                      </button>
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">
                        {category.icon ? <span className="mr-1.5">{category.icon}</span> : null}
                        {category.name}
                      </p>
                      <p className="truncate text-xs text-muted">
                        /c/{category.slug} · {category.videoCount}{' '}
                        {category.videoCount === 1 ? 'title' : 'titles'}
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <button type="button" className={button.tiny} onClick={() => setEditing(category.id)}>
                        Edit
                      </button>
                      {confirming === category.id ? (
                        <button
                          type="button"
                          className={button.danger}
                          disabled={busy}
                          onClick={async () => {
                            await call(`/api/admin/categories/${category.id}`, 'DELETE')
                            setConfirming(null)
                          }}
                        >
                          Delete and unfile {category.videoCount}
                        </button>
                      ) : (
                        <button type="button" className={button.tiny} onClick={() => setConfirming(category.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="New category">
        <form
          className="space-y-3 px-5 py-5"
          onSubmit={async (event) => {
            event.preventDefault()
            const element = event.currentTarget
            const form = new FormData(element)
            const ok = await call('/api/admin/categories', 'POST', {
              name: String(form.get('name') ?? ''),
              slug: String(form.get('slug') ?? '') || undefined,
              description: String(form.get('description') ?? ''),
              icon: String(form.get('icon') ?? ''),
            })
            if (ok) element.reset()
          }}
        >
          <label className="block">
            <Label>Name</Label>
            <input name="name" required maxLength={120} placeholder="Shonen" className={field} />
          </label>
          <label className="block">
            <Label hint="Optional">Slug</Label>
            <input name="slug" maxLength={120} placeholder="derived from the name" className={field} />
          </label>
          <label className="block">
            <Label hint="Optional">Description</Label>
            <input name="description" maxLength={2000} className={field} />
          </label>
          <label className="block">
            <Label hint="Optional">Icon</Label>
            <input name="icon" maxLength={60} placeholder="🔥" className={field} />
          </label>
          <button type="submit" className={button.primary} disabled={busy}>
            Create
          </button>
          <p className="text-xs text-muted">New categories go to the end of the order.</p>
        </form>
      </Panel>
    </div>
  )
}
