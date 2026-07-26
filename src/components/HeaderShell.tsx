'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

type Category = { slug: string; name: string }

/**
 * Top navigation.
 *
 * Transparent over the billboard and solid once the page scrolls. That is not
 * decoration: the hero runs to the top of the viewport, and a solid bar sitting
 * on top of it would crop the artwork and put a hard seam across the one image
 * the page is built around.
 *
 * Search is an icon that expands rather than a permanent field — on a catalogue
 * the primary action is browsing, and a wide search box parked in the header
 * makes it look like a site you are meant to query rather than one you are
 * meant to explore.
 */
export function HeaderShell({
  categories,
  user,
}: {
  categories: Category[]
  user: { displayName: string } | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [scrolled, setScrolled] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60)
    onScroll()

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  const primary = categories.slice(0, 4)

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-surface/85 shadow-[0_4px_24px_-12px_rgba(46,42,53,0.25)] backdrop-blur-xl'
          : 'bg-transparent'
      }`}
    >
      <div className="flex h-[68px] items-center gap-6 px-4 sm:px-12">
        <Link href="/" className="shrink-0" aria-label="Home">
          <span className="font-display text-2xl font-extrabold tracking-tight text-primary sm:text-3xl">
            Sakura
            <span className="text-secondary">TV</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-5 text-sm md:flex">
          <NavLink href="/" active={pathname === '/'}>
            Home
          </NavLink>
          {primary.map((category) => (
            <NavLink
              key={category.slug}
              href={`/c/${category.slug}`}
              active={pathname === `/c/${category.slug}`}
            >
              {category.name}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <form
            role="search"
            onSubmit={(event) => {
              event.preventDefault()
              const trimmed = query.trim()
              if (trimmed) router.push(`/search?q=${encodeURIComponent(trimmed)}`)
            }}
            className={`flex items-center rounded-full transition-all duration-300 ${
              searchOpen
                ? 'w-52 bg-surface px-2 shadow-inner ring-2 ring-primary/30 sm:w-64'
                : 'w-9'
            }`}
          >
            <button
              type="button"
              onClick={() => setSearchOpen((open) => !open)}
              aria-label={searchOpen ? 'Close search' : 'Search'}
              aria-expanded={searchOpen}
              className="shrink-0 rounded-full p-1.5 text-ink transition hover:bg-primary-soft"
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </button>

            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => {
                if (!query) setSearchOpen(false)
              }}
              placeholder="Search anime"
              aria-label="Search anime"
              tabIndex={searchOpen ? 0 : -1}
              className={`w-full bg-transparent py-1.5 text-sm text-ink outline-none placeholder:text-muted ${
                searchOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            />
          </form>

          {user ? (
            <div className="flex items-center gap-2">
              <Link
                href="/my-list"
                className="hidden text-sm font-semibold text-ink-soft transition hover:text-primary sm:block"
              >
                My List
              </Link>
              <button
                type="button"
                onClick={async () => {
                  await fetch('/api/auth/login', { method: 'DELETE', credentials: 'same-origin' })
                  router.refresh()
                }}
                title={`Signed in as ${user.displayName} — sign out`}
                aria-label="Sign out"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary text-xs font-extrabold text-white shadow-sm ring-2 ring-white"
              >
                {user.displayName.slice(0, 1).toUpperCase()}
              </button>
            </div>
          ) : (
            <Link
              href="/account"
              className="rounded-full bg-primary px-4 py-1.5 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={`whitespace-nowrap transition-colors ${
        active
          ? 'font-bold text-primary'
          : 'font-semibold text-ink-soft hover:text-primary'
      }`}
    >
      {children}
    </Link>
  )
}
