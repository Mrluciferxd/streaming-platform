/**
 * Shared plumbing for the checks under scripts/.
 *
 * The distinction this file exists to enforce: a *precondition* (no database,
 * no server, no credentials) is a reason to skip, and an *assertion* is a
 * reason to fail. Conflating them is how a suite ends up green on a machine
 * where nothing ran.
 *
 * Skips are printed by the test runner with their reason, and `CHECK_STRICT=1`
 * turns every unmet precondition into a failure — which is what CI should set
 * once the infrastructure it needs is actually provisioned.
 */

/**
 * Marks a suite as skippable. Returns the reason (skip) or `false` (run), which
 * is exactly the shape `describe(name, { skip }, fn)` wants.
 */
export function unmet(reason: string | null): string | false {
  if (!reason) return false

  if (process.env.CHECK_STRICT === '1') {
    throw new Error(
      `CHECK_STRICT=1 and a precondition is not met: ${reason}\n` +
        'Provision it, or unset CHECK_STRICT to let this check skip.',
    )
  }

  return reason
}

/**
 * Where a check should point when it needs a running server.
 *
 * Under `node --test` the positional arguments are file paths, so an argument
 * is only taken seriously if it looks like a URL.
 */
export function baseUrl(fallback = 'http://localhost:3000'): string {
  const fromArgv = process.argv.slice(2).find((arg) => /^https?:\/\//.test(arg))
  return (process.env.CHECK_BASE_URL ?? fromArgv ?? fallback).replace(/\/+$/, '')
}

/** Is anything answering there? Used to skip rather than fail on a dead server. */
export async function serverIsUp(base: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    // A 503 from /api/health is a live server with a sick dependency — still
    // worth running against, and the check itself will say what broke.
    return res.status === 200 || res.status === 503
  } catch {
    return false
  }
}

/** Every env var in `keys` that is missing or still holding a placeholder. */
export function missingEnv(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const value = process.env[key]
    return !value || value.includes('placeholder') || value.includes('example.com')
  })
}
