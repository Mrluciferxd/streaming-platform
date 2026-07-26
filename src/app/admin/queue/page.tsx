import type { Metadata } from 'next'
import Link from 'next/link'

import { RetryButton } from './RetryButton'
import { Empty, Panel, Pill, Stat, formatCount, formatDateTime } from '../ui'
import { requireAdminPage } from '@/lib/auth/require-role'
import { deadLetters, stats } from '@/lib/jobs/queue'
import { videoTitles } from '@/lib/queries/admin'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Queue' }

/**
 * Dead-letter queue.
 *
 * A job reaches `dead` after exhausting its retries, or immediately when the
 * worker decides the input can never decode. Either way it needs a person: the
 * video is stuck in `processing` and nothing else in the system will move it.
 * Without this page the only symptom is a title that never becomes ready.
 */
export default async function AdminQueuePage() {
  await requireAdminPage()

  const [counts, dead] = await Promise.all([stats(), deadLetters(50)])

  const videoIds = dead.flatMap((job) => {
    const payload = job.payload as { videoId?: unknown }
    return typeof payload?.videoId === 'string' ? [payload.videoId] : []
  })
  const titles = await videoTitles(videoIds)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {(['queued', 'running', 'done', 'failed', 'dead'] as const).map((status) => (
          <Stat key={status} label={status} value={formatCount(counts[status] ?? 0)} />
        ))}
      </div>

      <Panel
        title="Dead letters"
        hint="Retrying before fixing the cause just burns another few minutes of encode"
      >
        {dead.length === 0 ? (
          <Empty>Nothing has failed permanently. </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {dead.map((job) => {
              const payload = job.payload as { videoId?: string }
              const video = payload.videoId ? titles.get(payload.videoId) : undefined

              return (
                <li key={job.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Pill value={job.status} />
                    <span className="text-sm font-bold text-ink">
                      {video ? (
                        <Link href={`/admin/videos/${payload.videoId}`} className="hover:text-primary">
                          {video.title}
                        </Link>
                      ) : (
                        `${job.kind} #${job.id}`
                      )}
                    </span>
                    <span className="text-xs text-muted">
                      {job.kind} #{job.id} · {job.attempts}/{job.maxAttempts} attempts ·{' '}
                      {formatDateTime(job.finishedAt ?? job.updatedAt)}
                    </span>
                    <span className="ml-auto">
                      <RetryButton jobId={job.id} />
                    </span>
                  </div>

                  {job.lastError ? (
                    <pre className="mt-2.5 max-h-40 overflow-auto rounded-xl bg-mist p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-soft">
                      {job.lastError}
                    </pre>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>
    </div>
  )
}
