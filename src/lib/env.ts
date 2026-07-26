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

  /**
   * Which video provider is live. See src/lib/video/index.ts.
   *
   * `local` writes into public/media/ and is rejected in production below — it
   * serves every byte through the application process, which is exactly what
   * plan §3 exists to prevent.
   */
  VIDEO_PROVIDER: z.enum(['r2', 'bunny', 'local']).default('r2'),

  /** Explicit opt-in to VIDEO_PROVIDER=local in production. Demo deploys only. */
  ALLOW_LOCAL_MEDIA: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),

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

  /**
   * Shared secret for the cron endpoints. Vercel Cron sends it as a bearer
   * token; without it /api/cron/* is a public trigger for minutes of database
   * work.
   */
  CRON_SECRET: z.string().min(32),

  /** Largest source file accepted, in bytes. Default 20 GB. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 ** 3),

  /** Scratch space for the transcode worker. Needs several GB free. */
  WORKER_TMP_DIR: z.string().default('/tmp/transcode'),
  /** Concurrent transcodes per worker process. One per ~8 vCPU (plan §5). */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),

  /**
   * --- Advertising (plan §9) ---
   *
   * All optional, and everything is off unless switched on. An unconfigured
   * deploy loads no ad script and requests no ad; nothing here can affect
   * playback.
   *
   * The NEXT_PUBLIC_* entries are validated here so a malformed value fails at
   * boot on the server, but the browser cannot read this module — it throws
   * without the server secrets above. src/lib/ads/config.ts is the client-side
   * mirror, and Next only inlines these into the bundle when the property
   * access is written out literally, so the two cannot share a read.
   */
  NEXT_PUBLIC_ADS_ENABLED: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
  /** Google Ad Manager network code. Display slots build ad unit paths from it. */
  NEXT_PUBLIC_GAM_NETWORK_CODE: z.string().regex(/^\d+$/).optional(),
  /** VAST 4.x / VMAP ad tag for the pre-roll. GAM, AdSense for Video, or a test tag. */
  NEXT_PUBLIC_AD_VAST_TAG_URL: z.string().url().optional(),
  /** Pre-rolls per browsing session — `ad_placements.frequency_cap`. */
  NEXT_PUBLIC_AD_PREROLL_CAP: z.coerce.number().int().positive().default(3),
  /** Minimum gap between pre-rolls. This is what stops one per episode. */
  NEXT_PUBLIC_AD_PREROLL_COOLDOWN_SEC: z.coerce.number().int().positive().default(600),

  /** Seller of record in ads.txt, e.g. pub-0000000000000000. */
  ADS_TXT_GOOGLE_PUB_ID: z
    .string()
    .regex(/^pub-\d{16}$/, 'expected a Google publisher id like pub-0000000000000000')
    .optional(),
  /** Additional ads.txt records, separated by newlines or semicolons. */
  ADS_TXT_ENTRIES: z.string().optional(),
  /** Published as the CONTACT= line. Email or URL. */
  ADS_TXT_CONTACT: z.string().optional(),
  /** Serve /app-ads.txt. Only meaningful once a mobile app exists. */
  ADS_TXT_APP_ADS: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
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
  if (env.VIDEO_PROVIDER === 'local') {
    if (env.NODE_ENV === 'production' && !env.ALLOW_LOCAL_MEDIA) {
      throw new Error(
        'VIDEO_PROVIDER=local has no signed access, no cache-control strategy, ' +
          'and ships the whole library with the deployment. Set ALLOW_LOCAL_MEDIA=1 ' +
          'only for a throwaway demo deploy; never for real traffic.',
      )
    }

    if (env.NODE_ENV === 'production') {
      console.warn(
        '[env] VIDEO_PROVIDER=local in production. Media is served as static ' +
          'assets, not from R2, and every byte is billed at platform bandwidth ' +
          'rates — the exact cost profile plan §0 exists to avoid. Demo only.',
      )
    }
    return
  }

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
