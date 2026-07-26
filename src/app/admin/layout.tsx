import type { Metadata } from 'next'

import { AdminNav } from './AdminNav'
import { requireAdminPage } from '@/lib/auth/require-role'

// Every page here reads live operator state; none of it may be cached or
// prerendered, and a 404 for a non-operator must be decided per request.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin' },
  robots: { index: false, follow: false },
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Also enforced in every page below. A layout is not re-run on client-side
  // navigation within the segment, so it is a convenience here, not the gate.
  const user = await requireAdminPage()

  return (
    // pt-[68px] clears the site header, which is fixed and owned by the root
    // layout.
    <div className="min-h-dvh bg-mist pt-[68px]">
      <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-8">
        <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="font-display text-xl font-extrabold tracking-tight text-ink">Operator</h1>
          <span className="rounded-full bg-surface px-3 py-1 text-xs font-bold text-ink-soft ring-1 ring-line">
            {user.displayName} · {user.role}
          </span>
        </div>

        <AdminNav />

        <div className="mt-5">{children}</div>
      </div>
    </div>
  )
}
