'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { button } from './ui'

/**
 * Run the scheduled-publish sweep by hand.
 *
 * The same endpoint is meant to be on cron; this exists so that a schedule is
 * not silently dependent on a cron entry nobody added, and so an operator who
 * scheduled something for 18:00 can push it out at 18:01 without editing rows.
 */
export function PublishDueButton() {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'running' | string>('idle')

  return (
    <button
      type="button"
      disabled={state === 'running'}
      onClick={async () => {
        setState('running')
        try {
          const response = await fetch('/api/admin/publish-due', {
            method: 'POST',
            credentials: 'same-origin',
          })
          const data = (await response.json().catch(() => ({}))) as { published?: number }

          setState(response.ok ? `${data.published ?? 0} published` : 'failed')
          router.refresh()
        } catch {
          setState('failed')
        }
      }}
      className={button.ghost}
      title="Publish every title whose scheduled time has passed"
    >
      {state === 'running' ? 'Running…' : state === 'idle' ? 'Run schedule' : state}
    </button>
  )
}
