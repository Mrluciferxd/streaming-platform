import { sql } from 'drizzle-orm'
import { db } from '@/db'

export const dynamic = 'force-dynamic'

/**
 * Placeholder home page. Its only real job right now is proving the deploy path
 * end-to-end — plan §12 Phase 1: "Deploy a hello-world to production on day 3."
 */
export default async function Home() {
  let dbStatus: string
  try {
    const [row] = await db.execute<{ now: Date }>(sql`select now() as now`)
    dbStatus = row ? `connected · ${row.now}` : 'connected'
  } catch (error) {
    dbStatus = `unreachable — ${error instanceof Error ? error.message : String(error)}`
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <div>
        <p className="text-sm font-medium text-neutral-500">Phase 1 · Foundation</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Streaming Platform</h1>
      </div>

      <dl className="grid gap-3 text-sm">
        <Row label="Video provider" value={process.env.VIDEO_PROVIDER ?? 'r2'} />
        <Row label="CDN origin" value={process.env.NEXT_PUBLIC_CDN_URL ?? 'not configured'} />
        <Row label="Database" value={dbStatus} />
      </dl>

      <p className="text-sm text-neutral-500">
        Next up: TUS resumable upload, the FFmpeg ladder, and HLS packaging (plan §12 Phase 2).
      </p>
    </main>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="font-mono text-xs break-all">{value}</dd>
    </div>
  )
}
