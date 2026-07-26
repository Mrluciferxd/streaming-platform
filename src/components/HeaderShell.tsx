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
export function HeaderShell({ categories }: { categories: Category[] }) {
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
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled ? 'bg-[#141414]' : 'bg-gradient-to-b from-black/80 to-transparent'
      }`}
    >
      <div className="flex h-[68px] items-center gap-6 px-4 sm:px-12">
        <Link href="/" className="shrink-0" aria-label="Home">
          <span className="text-2xl font-black tracking-tighter text-[#e50914] sm:text-3xl">
            STREAMFLIX
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
            className={`flex items-center transition-all duration-300 ${
              searchOpen
                ? 'w-52 border border-white/40 bg-black/80 px-2 sm:w-64'
                : 'w-8 border border-transparent'
            }`}
          >
            <button
              type="button"
              onClick={() => setSearchOpen((open) => !open)}
              aria-label={searchOpen ? 'Close search' : 'Search'}
              aria-expanded={searchOpen}
              className="shrink-0 p-1 text-white"
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
              placeholder="Titles"
              aria-label="Search titles"
              tabIndex={searchOpen ? 0 : -1}
              className={`w-full bg-transparent py-1.5 text-sm text-white outline-none placeholder:text-white/50 ${
                searchOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            />
          </form>

          {/* Profile avatar. A placeholder until accounts exist. */}
          <div
            aria-hidden
            className="h-8 w-8 shrink-0 rounded bg-gradient-to-br from-[#e50914] to-[#7b0710]"
          />
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
        active ? 'font-semibold text-white' : 'text-[#e5e5e5] hover:text-white/70'
      }`}
    >
      {children}
    </Link>
  )
}
