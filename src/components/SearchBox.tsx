'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

type Suggestion = { slug: string; title: string; posterUrl: string | null }

/** Search with autocomplete (plan §7 MVP). */
export function SearchBox() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setSuggestions([])
      return
    }

    // Debounced, and the in-flight request is aborted when the query moves on —
    // without that, results arrive out of order and the dropdown flickers
    // between stale and current matches.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search/suggest?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((data: { items: Suggestion[] }) => {
          setSuggestions(data.items)
          setHighlighted(-1)
        })
        .catch(() => {})
    }, 180)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  function submit(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return

    setOpen(false)
    router.push(`/search?q=${encodeURIComponent(trimmed)}`)
  }

  return (
    <div ref={containerRef} className="relative">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          submit(query)
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setHighlighted((i) => Math.min(i + 1, suggestions.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlighted((i) => Math.max(i - 1, -1))
            } else if (event.key === 'Enter' && highlighted >= 0) {
              event.preventDefault()
              const picked = suggestions[highlighted]
              if (picked) {
                setOpen(false)
                router.push(`/watch/${picked.slug}`)
              }
            } else if (event.key === 'Escape') {
              setOpen(false)
            }
          }}
          placeholder="Search videos"
          aria-label="Search videos"
          aria-expanded={open && suggestions.length > 0}
          aria-autocomplete="list"
          className="w-full rounded-full border border-neutral-300 bg-white px-4 py-1.5 text-sm outline-none transition focus:border-red-600 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </form>

      {open && suggestions.length > 0 ? (
        <ul className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.slug}>
              <Link
                href={`/watch/${suggestion.slug}`}
                onClick={() => setOpen(false)}
                className={`block px-4 py-2 text-sm transition ${
                  index === highlighted
                    ? 'bg-neutral-100 dark:bg-neutral-800'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60'
                }`}
              >
                {suggestion.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
