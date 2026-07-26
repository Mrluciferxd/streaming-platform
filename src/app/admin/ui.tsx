/**
 * Shared admin chrome.
 *
 * The admin surface is denser and plainer than the catalogue — tables, not key
 * art — but it stays on the same palette and type. A separate visual language
 * for the back office is a second design system to maintain, and operators
 * switch between the two all day.
 *
 * Nothing here may import from the database or `@/lib/env`: these components are
 * used from client components too, and either import would drag server-only code
 * into the browser bundle.
 */

const numbers = new Intl.NumberFormat('en-IN')

export function formatCount(value: number): string {
  return numbers.format(value)
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '—'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent

  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

/** Watch time reads as hours once it is real; seconds until then. */
export function formatWatchTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${numbers.format(Math.round(seconds / 3600))}h`
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return '—'

  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Fixed locale and time zone.
 *
 * Server components render this once on a UTC machine and the markup is never
 * re-rendered in the browser, so leaving it to the client's locale would print
 * one time zone in dev and another in production. IST is pinned because the
 * operators are in India and a publish schedule is a local decision.
 */
const dateTime = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
})

export function formatDateTime(value: Date | string | null): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(date.getTime()) ? '—' : `${dateTime.format(date)} IST`
}

export function Panel({
  title,
  hint,
  actions,
  children,
}: {
  title?: string
  hint?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl bg-surface ring-1 ring-line">
      {title ? (
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="font-display text-base font-extrabold tracking-tight text-ink">{title}</h2>
            {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
          </div>
          {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-mist text-muted',
  uploading: 'bg-secondary-soft text-secondary',
  processing: 'bg-secondary-soft text-secondary',
  ready: 'bg-accent-soft text-accent',
  published: 'bg-accent-soft text-accent',
  unpublished: 'bg-mist text-ink-soft',
  failed: 'bg-primary-soft text-primary',
  removed: 'bg-primary-soft text-primary',
  deleted: 'bg-primary-soft text-primary',
  queued: 'bg-mist text-ink-soft',
  running: 'bg-secondary-soft text-secondary',
  done: 'bg-accent-soft text-accent',
  dead: 'bg-primary-soft text-primary',
}

export function Pill({ value, muted = false }: { value: string; muted?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold whitespace-nowrap ${
        muted ? 'bg-mist text-ink-soft' : (STATUS_STYLE[value] ?? 'bg-mist text-ink-soft')
      }`}
    >
      {value}
    </span>
  )
}

export function Meter({ percent, tone = 'primary' }: { percent: number; tone?: 'primary' | 'secondary' | 'accent' }) {
  const clamped = Math.max(0, Math.min(100, percent))
  const fill = tone === 'accent' ? 'bg-accent' : tone === 'secondary' ? 'bg-secondary' : 'bg-primary'

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-mist" role="presentation">
      <div className={`h-full rounded-full ${fill} transition-[width] duration-300`} style={{ width: `${clamped}%` }} />
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-12 text-center text-sm text-muted">{children}</p>
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-2xl bg-surface px-5 py-4 ring-1 ring-line">
      <p className="text-[11px] font-bold tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl font-extrabold tracking-tight text-ink">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-ink-soft">{sub}</p> : null}
    </div>
  )
}

/** Shared control classes, so a button in one page does not drift from another. */
export const button = {
  primary:
    'inline-flex items-center justify-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:brightness-105 disabled:opacity-50',
  ghost:
    'inline-flex items-center justify-center gap-1.5 rounded-full bg-mist px-4 py-2 text-sm font-bold text-ink-soft transition hover:bg-line disabled:opacity-50',
  danger:
    'inline-flex items-center justify-center gap-1.5 rounded-full bg-primary-soft px-4 py-2 text-sm font-bold text-primary transition hover:brightness-95 disabled:opacity-50',
  tiny: 'inline-flex items-center justify-center rounded-full bg-mist px-2.5 py-1 text-xs font-bold text-ink-soft transition hover:bg-line disabled:opacity-40',
} as const

export const field =
  'w-full rounded-xl bg-mist px-3 py-2 text-sm text-ink outline-none ring-primary/40 focus:ring-2'

export function Label({
  children,
  hint,
}: {
  children: React.ReactNode
  hint?: string
}) {
  return (
    <span className="mb-1 flex items-baseline justify-between gap-2 text-xs font-bold text-ink">
      {children}
      {hint ? <span className="text-right font-medium text-muted">{hint}</span> : null}
    </span>
  )
}
