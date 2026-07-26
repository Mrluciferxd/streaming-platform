import { HeaderShell } from '@/components/HeaderShell'
import { listCategories } from '@/lib/queries/videos'

export async function SiteHeader() {
  const categories = await listCategories()

  return (
    <HeaderShell
      categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
    />
  )
}
