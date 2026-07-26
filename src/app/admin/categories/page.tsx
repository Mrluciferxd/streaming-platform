import type { Metadata } from 'next'

import { CategoryManager } from './CategoryManager'
import { requireAdminPage } from '@/lib/auth/require-role'
import { listAdminCategories } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Categories' }

export default async function AdminCategoriesPage() {
  await requireAdminPage()

  const categories = await listAdminCategories()

  return (
    <CategoryManager
      initial={categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        icon: c.icon,
        videoCount: c.videoCount,
      }))}
    />
  )
}
