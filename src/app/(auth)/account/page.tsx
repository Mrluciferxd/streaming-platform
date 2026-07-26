import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { AuthForm } from './AuthForm'
import { getSessionUser } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Account',
  robots: { index: false, follow: false },
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const user = await getSessionUser()
  const next = (await searchParams).next

  // Only same-origin paths. Accepting an arbitrary `next` would make this an
  // open redirect — the classic way a sign-in page gets used for phishing.
  const redirectTo = next && /^\/(?!\/)/.test(next) ? next : '/'

  if (user) redirect(redirectTo)

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-24">
      <div className="w-full">
        <div className="mb-6 text-center">
          <Link href="/" className="font-display text-3xl font-extrabold tracking-tight text-primary">
            Sakura<span className="text-secondary">TV</span>
          </Link>
        </div>
        <AuthForm redirectTo={redirectTo} />
      </div>
    </div>
  )
}
