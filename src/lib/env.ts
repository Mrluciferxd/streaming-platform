import { z } from 'zod'

/**
 * Server-side environment. Validated once at module load so a misconfigured
 * deploy fails at boot rather than on the first request.
 *
 * Never import this from a client component — it would leak secrets into the
 * browser bundle. Client-visible config lives in `clientEnv` below.
 */
const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  // PgBouncer in transaction mode cannot handle prepared statements (plan §8).
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_PREPARE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  REDIS_URL: z.string().url().optional(),

  // Which video provider is live. See src/lib/video/index.ts.
  VIDEO_PROVIDER: z.enum(['r2', 'bunny']).default('r2'),

  // --- Cloudflare R2 (provider: r2) ---
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  // Public custom domain bound to the bucket. This is what the CDN serves from.
  R2_PUBLIC_BASE_URL: z.string().url().optional(),

  // --- Bunny Stream (provider: bunny) ---
  BUNNY_LIBRARY_ID: z.string().optional(),
  BUNNY_API_KEY: z.string().optional(),
  BUNNY_CDN_HOSTNAME: z.string().optional(),

  /**
   * HMAC key for signing playback tokens.
   *
   * Read the comment in src/lib/video/token.ts before changing how this is
   * used: signing individual segment URLs collapses the CDN cache hit ratio and
   * is the single most expensive mistake available in this architecture.
   */
  PLAYBACK_TOKEN_SECRET: z.string().min(32),
  PLAYBACK_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(21600),

  AUTH_SECRET: z.string().min(32),
})

const parsed = serverSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  throw new Error(`Invalid environment configuration:\n${issues}`)
}

export const env = parsed.data

/**
 * Cross-field checks the flat schema can't express: each provider needs its own
 * credential set, and only the selected one is required.
 */
function assertProviderConfig() {
  if (env.VIDEO_PROVIDER === 'r2') {
    const required = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_PUBLIC_BASE_URL',
    ] as const
    const missing = required.filter((k) => !env[k])
    if (missing.length > 0) {
      throw new Error(
        `VIDEO_PROVIDER=r2 requires: ${missing.join(', ')}`,
      )
    }
  } else {
    const required = ['BUNNY_LIBRARY_ID', 'BUNNY_API_KEY', 'BUNNY_CDN_HOSTNAME'] as const
    const missing = required.filter((k) => !env[k])
    if (missing.length > 0) {
      throw new Error(
        `VIDEO_PROVIDER=bunny requires: ${missing.join(', ')}`,
      )
    }
  }
}

assertProviderConfig()

export const isProd = env.NODE_ENV === 'production'
