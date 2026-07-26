'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { button, field, formatBytes, Label, Meter, Panel } from '../ui'

/**
 * Direct-to-storage resumable upload.
 *
 * Bytes go browser → R2 on presigned URLs and never touch the app server
 * (plan §5.1). That constraint is what shapes this component: it has to do the
 * part slicing, the concurrency, the retries and the resume itself, because
 * there is no server in the data path to do any of it.
 *
 * Resume is against the *bucket*, not against anything remembered here.
 * `GET /api/upload/:id` asks R2 which parts actually landed, so a resume works
 * after a browser crash, on a different machine, or hours later — client-side
 * bookkeeping would only be a guess, and a wrong guess corrupts the object.
 */

/** Parallel part PUTs. */
const CONCURRENCY = 4
/**
 * Four, not sixteen. The target connection drops every few minutes, and every
 * extra parallel PUT is another few MB in flight to lose when it does — while
 * the throughput gain past four is small on a link this size.
 */

/** Parts presigned per round trip. The endpoint caps a batch at 100. */
const PRESIGN_BATCH = 50

const MAX_PART_ATTEMPTS = 5

const STORAGE_KEY = 'admin.upload.inflight'

type Session = {
  uploadId: string
  videoId: string
  slug: string
  title: string
  partSizeBytes: number
  totalParts: number
  fileName: string
  fileSize: number
  lastModified: number
}

type Phase = 'idle' | 'starting' | 'uploading' | 'paused' | 'finalising' | 'done' | 'error'

class PartError extends Error {
  constructor(readonly status: number) {
    super(`part rejected with ${status}`)
  }
}

export function Uploader() {
  const [session, setSession] = useState<Session | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [progress, setProgress] = useState({ bytes: 0, total: 0, parts: 0, totalParts: 0, retries: 0 })

  // Progress arrives per XHR chunk — hundreds of events a second on a fast
  // link. Accumulate in a ref and publish on a timer so React re-renders at
  // human speed instead of fighting the upload for the main thread.
  const live = useRef({ bytes: 0, total: 0, parts: 0, totalParts: 0, retries: 0 })
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return

    try {
      setSession(JSON.parse(stored) as Session)
      setPhase('paused')
    } catch {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'uploading') return

    const timer = window.setInterval(() => setProgress({ ...live.current }), 250)
    return () => window.clearInterval(timer)
  }, [phase])

  const persist = useCallback((next: Session | null) => {
    setSession(next)
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    else window.localStorage.removeItem(STORAGE_KEY)
  }, [])

  /** The transfer loop. Safe to call again on the same session — that is resume. */
  const transfer = useCallback(
    async (source: File, active: Session) => {
      const controller = new AbortController()
      abort.current = controller
      setPhase('uploading')
      setMessage(null)

      try {
        // R2 is the source of truth for what has landed, every time — including
        // the very first run, which costs one round trip and removes a whole
        // class of "the client thought it had uploaded that" bugs.
        const status = await getJson<{
          missing: number[]
          bytesStored: number
          totalParts: number
          status: string
        }>(`/api/upload/${active.uploadId}`)

        if (status.status !== 'pending') {
          throw new Error(`This upload is already ${status.status}.`)
        }

        live.current = {
          bytes: status.bytesStored,
          total: active.fileSize,
          parts: active.totalParts - status.missing.length,
          totalParts: active.totalParts,
          retries: live.current.retries,
        }
        setProgress({ ...live.current })

        for (const batch of chunk(status.missing, PRESIGN_BATCH)) {
          if (controller.signal.aborted) return

          const signed = await postJson<{ urls: { partNumber: number; url: string }[] }>(
            `/api/upload/${active.uploadId}`,
            { partNumbers: batch },
            controller.signal,
          )

          const urls = new Map(signed.urls.map((u) => [u.partNumber, u.url]))
          const queue = [...batch]

          const worker = async () => {
            for (;;) {
              const partNumber = queue.shift()
              if (partNumber === undefined || controller.signal.aborted) return

              const url = urls.get(partNumber)
              if (!url) throw new Error(`No presigned URL for part ${partNumber}.`)

              await sendPart(active, source, partNumber, url, controller.signal, live)
              live.current.parts += 1
            }
          }

          await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
        }

        if (controller.signal.aborted) return

        setPhase('finalising')
        // The server reads the part list back from R2 rather than trusting
        // anything sent from here, so there is nothing to hand it.
        await postJson(`/api/upload/${active.uploadId}/complete`, {}, controller.signal)

        persist(null)
        setPhase('done')
      } catch (error) {
        if (controller.signal.aborted) {
          setPhase('paused')
          return
        }

        setPhase('error')
        setMessage(describe(error))
      } finally {
        abort.current = null
      }
    },
    [persist],
  )

  async function start(form: FormData) {
    const picked = form.get('file')
    if (!(picked instanceof File) || picked.size === 0) {
      setMessage('Choose a video file.')
      return
    }

    setPhase('starting')
    setMessage(null)

    try {
      const created = await postJson<{
        videoId: string
        slug: string
        uploadId: string
        plan: { protocol: string; partSizeBytes: number; totalParts: number }
      }>('/api/upload/create', {
        filename: picked.name,
        contentType: picked.type || 'video/mp4',
        sizeBytes: picked.size,
        title: String(form.get('title') ?? '').trim() || picked.name,
        language: String(form.get('language') ?? 'hi'),
      })

      if (created.plan.protocol !== 'multipart') {
        throw new Error('This provider returned a TUS plan, which this screen does not drive.')
      }

      const next: Session = {
        uploadId: created.uploadId,
        videoId: created.videoId,
        slug: created.slug,
        title: String(form.get('title') ?? '').trim() || picked.name,
        partSizeBytes: created.plan.partSizeBytes,
        totalParts: created.plan.totalParts,
        fileName: picked.name,
        fileSize: picked.size,
        lastModified: picked.lastModified,
      }

      persist(next)
      setFile(picked)
      await transfer(picked, next)
    } catch (error) {
      setPhase('error')
      setMessage(describe(error))
    }
  }

  function attachForResume(picked: File) {
    if (!session) return

    // Name and size, not a hash: hashing 2 GB in the browser to check a resume
    // costs more than re-uploading the parts it would save.
    if (picked.name !== session.fileName || picked.size !== session.fileSize) {
      setWarning(
        `That is not the same file. Expected ${session.fileName} at ${formatBytes(session.fileSize)}.`,
      )
      return
    }

    setWarning(
      picked.lastModified !== session.lastModified
        ? 'Same name and size but a different modification time — fine if this is a copy of the file, wrong if it was re-encoded.'
        : null,
    )
    setFile(picked)
  }

  async function discard() {
    if (!session) return

    abort.current?.abort()
    // Without this the parts already in R2 keep billing as storage while being
    // invisible in the bucket listing.
    await fetch(`/api/upload/${session.uploadId}`, { method: 'DELETE', credentials: 'same-origin' })

    persist(null)
    setFile(null)
    setPhase('idle')
    setMessage(null)
    setWarning(null)
  }

  if (phase === 'done' && session === null) {
    return (
      <Panel title="Upload complete">
        <div className="space-y-3 px-5 py-6 text-sm">
          <p className="text-ink-soft">
            The source is in the bucket and a transcode job is queued. The title stays out of the
            catalogue until someone publishes it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin" className={button.primary}>
              Back to the library
            </Link>
            <button type="button" className={button.ghost} onClick={() => setPhase('idle')}>
              Upload another
            </button>
          </div>
        </div>
      </Panel>
    )
  }

  if (session) {
    const percent = progress.total > 0 ? (progress.bytes / progress.total) * 100 : 0
    const busy = phase === 'uploading' || phase === 'finalising'

    return (
      <Panel
        title={session.title}
        hint={`${session.fileName} · ${formatBytes(session.fileSize)} · ${session.totalParts} parts of ${formatBytes(session.partSizeBytes)}`}
      >
        <div className="space-y-4 px-5 py-5">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-sm">
              <span className="font-bold text-ink">
                {phase === 'finalising' ? 'Finalising…' : `${percent.toFixed(1)}%`}
              </span>
              <span className="text-xs text-muted">
                {formatBytes(progress.bytes)} of {formatBytes(progress.total || session.fileSize)} ·{' '}
                {progress.parts}/{progress.totalParts || session.totalParts} parts
                {progress.retries > 0 ? ` · ${progress.retries} retried` : ''}
              </span>
            </div>
            <Meter percent={phase === 'finalising' ? 100 : percent} tone={busy ? 'secondary' : 'primary'} />
          </div>

          {phase === 'paused' && !file ? (
            <div className="rounded-xl bg-mist px-4 py-3.5">
              <p className="text-sm font-bold text-ink">Interrupted upload</p>
              <p className="mt-1 text-xs text-ink-soft">
                The parts already in the bucket are kept. Re-select{' '}
                <span className="font-semibold">{session.fileName}</span> to continue from where it
                stopped — browsers cannot hold on to a file across a reload.
              </p>
              <input
                type="file"
                accept="video/*"
                onChange={(event) => {
                  const picked = event.target.files?.[0]
                  if (picked) attachForResume(picked)
                }}
                className="mt-2.5 block w-full text-xs text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-3.5 file:py-1.5 file:text-xs file:font-bold file:text-white"
              />
            </div>
          ) : null}

          {warning ? (
            <p className="rounded-xl bg-secondary-soft px-3.5 py-2.5 text-xs font-semibold text-secondary">
              {warning}
            </p>
          ) : null}

          {message ? (
            <p role="alert" className="rounded-xl bg-primary-soft px-3.5 py-2.5 text-xs font-semibold text-primary">
              {message}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {busy ? (
              <button type="button" className={button.ghost} onClick={() => abort.current?.abort()}>
                Pause
              </button>
            ) : (
              <button
                type="button"
                className={button.primary}
                disabled={!file}
                onClick={() => file && transfer(file, session)}
              >
                {phase === 'error' ? 'Retry' : 'Resume'}
              </button>
            )}

            <Link href={`/admin/videos/${session.videoId}`} className={button.ghost}>
              Edit metadata
            </Link>

            <button type="button" className={button.danger} onClick={discard} disabled={busy}>
              Discard upload
            </button>
          </div>
        </div>
      </Panel>
    )
  }

  return (
    <Panel title="New upload" hint="The file goes straight to storage; this server never sees the bytes.">
      <form
        className="space-y-4 px-5 py-5"
        onSubmit={(event) => {
          event.preventDefault()
          void start(new FormData(event.currentTarget))
        }}
      >
        <label className="block">
          <Label hint="Rename it later in the editor">Title</Label>
          <input name="title" maxLength={200} placeholder="Falls back to the filename" className={field} />
        </label>

        <label className="block">
          <Label hint="ISO 639-1">Language</Label>
          <input name="language" defaultValue="hi" maxLength={10} className={field} />
        </label>

        <label className="block">
          <Label>Source file</Label>
          <input
            name="file"
            type="file"
            accept="video/*"
            required
            className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-bold file:text-white"
          />
        </label>

        {message ? (
          <p role="alert" className="rounded-xl bg-primary-soft px-3.5 py-2.5 text-xs font-semibold text-primary">
            {message}
          </p>
        ) : null}

        <button type="submit" className={button.primary} disabled={phase === 'starting'}>
          {phase === 'starting' ? 'Starting…' : 'Start upload'}
        </button>
      </form>
    </Panel>
  )
}

/**
 * One part, with retries.
 *
 * A 403 is treated as an expired signature rather than a permission failure:
 * presigned URLs live an hour and a 20 GB upload on a slow link outlasts that,
 * so the batch signed at the start goes stale mid-flight. Re-signing the single
 * part is much cheaper than shortening the batch or refusing long uploads.
 */
async function sendPart(
  session: Session,
  source: File,
  partNumber: number,
  initialUrl: string,
  signal: AbortSignal,
  live: React.RefObject<{ bytes: number; retries: number }>,
): Promise<void> {
  const start = (partNumber - 1) * session.partSizeBytes
  const blob = source.slice(start, Math.min(start + session.partSizeBytes, source.size))

  let url = initialUrl
  let counted = 0

  for (let attempt = 1; ; attempt++) {
    try {
      await put(url, blob, signal, (loaded) => {
        // Progress is reported as a running total per part; only the delta goes
        // into the global counter, so a retry cannot double-count.
        live.current.bytes += loaded - counted
        counted = loaded
      })

      // The final onprogress can lag the load event on some browsers.
      live.current.bytes += blob.size - counted
      return
    } catch (error) {
      if (signal.aborted) throw error

      // Roll back this attempt's bytes before retrying.
      live.current.bytes -= counted
      counted = 0

      const status = error instanceof PartError ? error.status : 0
      // 4xx other than an expired signature will fail identically forever.
      if (status >= 400 && status < 500 && status !== 403 && status !== 408) throw error
      if (attempt >= MAX_PART_ATTEMPTS) throw error

      live.current.retries += 1

      if (status === 403) {
        const signed = await postJson<{ urls: { partNumber: number; url: string }[] }>(
          `/api/upload/${session.uploadId}`,
          { partNumbers: [partNumber] },
          signal,
        )
        url = signed.urls[0]?.url ?? url
      }

      // Jitter, so a dropped link does not bring every worker back in lockstep.
      await delay(Math.min(300 * 2 ** (attempt - 1), 8000) + Math.random() * 250, signal)
    }
  }
}

/**
 * XHR rather than fetch, only because fetch still cannot report upload
 * progress — a 2 GB upload with no progress bar reads as a hung page.
 */
function put(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()

    xhr.open('PUT', url, true)
    xhr.upload.onprogress = (event) => onProgress(event.loaded)
    xhr.onload = () => {
      signal.removeEventListener('abort', onAbort)
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new PartError(xhr.status))
    }
    xhr.onerror = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Network error while uploading a part.'))
    }
    xhr.onabort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('aborted', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    // No Content-Type: File.slice() produces a typeless Blob, so the browser
    // sends none, and an unsigned header would not match the presigned request.
    xhr.send(blob)
  })
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
  return unwrap<T>(response)
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  })
  return unwrap<T>(response)
}

async function unwrap<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (response.ok) return data

  if (response.status === 404 && data.error === 'not_found') {
    throw new Error('Not found, or your session is no longer an operator session. Reload and sign in.')
  }

  throw new Error(data.error ? `${data.error} (${response.status})` : `Request failed (${response.status})`)
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // The most likely first-run failure by far, and the browser's own message
    // ("Failed to fetch") says nothing useful about it.
    if (error.message.includes('Network error')) {
      return 'Network error uploading to storage. If this is the first upload against this bucket, check the R2 CORS rules allow PUT from this origin, and that connect-src in next.config.ts includes the R2 endpoint.'
    }
    return error.message
  }
  return String(error)
}
