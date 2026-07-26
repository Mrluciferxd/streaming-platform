import { HeaderShell } from '@/components/HeaderShell'
import { getSessionUser } from '@/lib/auth/session'
import { listCategories } from '@/lib/queries/videos'

export async function SiteHeader() {
  const [categories, user] = await Promise.all([listCategories(), getSessionUser()])

  return (
    <HeaderShell
      categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
      user={user ? { displayName: user.displayName } : null}
    />
  )
}
