import type { Metadata } from 'next'

import { Uploader } from './Uploader'
import { requireAdminPage } from '@/lib/auth/require-role'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Upload' }

export default async function AdminUploadPage() {
  await requireAdminPage()

  return (
    <div className="max-w-2xl space-y-4">
      <Uploader />

      <p className="px-1 text-xs leading-relaxed text-muted">
        Parts are 8 MB, uploaded four at a time straight to the bucket. An interrupted upload
        resumes from what the bucket actually holds, not from anything this page remembers — so
        closing the tab, losing the connection, or moving to another machine all cost at most one
        part. Transcoding starts when the last part lands; the title stays out of the catalogue
        until it is published.
      </p>
    </div>
  )
}
