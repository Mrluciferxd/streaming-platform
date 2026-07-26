'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { button } from '../ui'

export function RetryButton({ jobId }: { jobId: number }) {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')

  return (
    <button
      type="button"
      disabled={state === 'busy'}
      className={button.ghost}
      onClick={async () => {
        setState('busy')
        try {
          const response = await fetch(`/api/admin/jobs/${jobId}/retry`, {
            method: 'POST',
            credentials: 'same-origin',
          })
          setState(response.ok ? 'idle' : 'failed')
          if (response.ok) router.refresh()
        } catch {
          setState('failed')
        }
      }}
    >
      {state === 'busy' ? 'Queueing…' : state === 'failed' ? 'Failed — retry' : 'Retry'}
    </button>
  )
}
