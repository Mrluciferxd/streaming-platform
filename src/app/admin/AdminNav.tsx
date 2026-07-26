'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/admin', label: 'Library' },
  { href: '/admin/upload', label: 'Upload' },
  { href: '/admin/categories', label: 'Categories' },
  { href: '/admin/analytics', label: 'Analytics' },
  { href: '/admin/queue', label: 'Queue' },
  { href: '/admin/audit', label: 'Audit log' },
] as const

export function AdminNav() {
  const pathname = usePathname()

  return (
    <nav className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto" aria-label="Admin sections">
      {TABS.map((tab) => {
        // Every other tab is a prefix match so a detail page keeps its section
        // lit; /admin itself would then match everything.
        const active = tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href)

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold whitespace-nowrap transition ${
              active ? 'bg-primary text-white shadow-sm' : 'text-ink-soft hover:bg-surface'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
