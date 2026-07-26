'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

type Mode = 'login' | 'register'

/**
 * Sign in / create account.
 *
 * One component with a mode toggle rather than two routes: the fields are
 * nearly identical, and switching between them is the single most common thing
 * someone does on this screen — a full navigation for it loses whatever they
 * already typed.
 */
export function AuthForm({ redirectTo = '/' }: { redirectTo?: string }) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('login')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const form = new FormData(event.currentTarget)
    const payload =
      mode === 'register'
        ? {
            email: String(form.get('email') ?? ''),
            password: String(form.get('password') ?? ''),
            displayName: String(form.get('displayName') ?? ''),
            consent: form.get('consent') === 'on',
          }
        : {
            email: String(form.get('email') ?? ''),
            password: String(form.get('password') ?? ''),
          }

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        setError(
          data.error === 'registration_failed'
            ? 'Could not create that account. Try signing in instead.'
            : data.error === 'invalid_request'
              ? 'Check the details and try again. Passwords need at least 10 characters.'
              : 'Email or password is incorrect.',
        )
        return
      }

      // refresh() re-runs the server components so the header picks up the new
      // session; push() alone would render the old, signed-out tree from cache.
      router.push(redirectTo)
      router.refresh()
    } catch {
      setError('Could not reach the server. Check your connection.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-md rounded-3xl bg-surface p-7 shadow-[0_20px_50px_-30px_rgba(124,107,240,0.5)] ring-1 ring-line">
      <h1 className="font-display text-2xl font-extrabold tracking-tight">
        {mode === 'login' ? 'Welcome back' : 'Create your account'}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        {mode === 'login'
          ? 'Sign in to keep your list and pick up where you left off.'
          : 'Free, and it keeps your list and progress across devices.'}
      </p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        {mode === 'register' ? (
          <Field label="Display name">
            <input
              name="displayName"
              required
              maxLength={80}
              autoComplete="nickname"
              className="w-full rounded-xl bg-mist px-4 py-2.5 text-sm outline-none ring-primary/40 focus:ring-2"
            />
          </Field>
        ) : null}

        <Field label="Email">
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-xl bg-mist px-4 py-2.5 text-sm outline-none ring-primary/40 focus:ring-2"
          />
        </Field>

        <Field label="Password" hint={mode === 'register' ? 'At least 10 characters' : undefined}>
          <input
            name="password"
            type="password"
            required
            minLength={mode === 'register' ? 10 : 1}
            // Tells password managers to offer a generated password on signup
            // and the saved one on login.
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            className="w-full rounded-xl bg-mist px-4 py-2.5 text-sm outline-none ring-primary/40 focus:ring-2"
          />
        </Field>

        {mode === 'register' ? (
          <label className="flex items-start gap-2.5 text-xs leading-relaxed text-ink-soft">
            {/*
              DPDP Act 2023 requires consent to be explicit and demonstrable, so
              it is an unchecked box the person has to tick — not a notice that
              signing up implies agreement. The timestamp and policy version go
              on the user row.
            */}
            <input
              name="consent"
              type="checkbox"
              required
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#ff5c8a]"
            />
            <span>
              I agree to the Terms of Service and consent to my personal data being processed as
              described in the Privacy Policy.
            </span>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-xl bg-primary-soft px-3 py-2 text-xs font-semibold text-primary">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-full bg-primary px-6 py-3 text-sm font-bold text-white shadow-lg shadow-primary/30 transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60"
        >
          {pending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-ink-soft">
        {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setError(null)
          }}
          className="font-bold text-primary hover:underline"
        >
          {mode === 'login' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between text-xs font-bold text-ink">
        {label}
        {hint ? <span className="font-medium text-muted">{hint}</span> : null}
      </span>
      {children}
    </label>
  )
}
