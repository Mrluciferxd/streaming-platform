import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { promisify } from 'node:util'

/**
 * `promisify` picks the first overload, which is the one without an options
 * argument — so the cast is what keeps the tuning parameters below type-checked
 * rather than silently dropped.
 */
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

/**
 * Password hashing.
 *
 * scrypt rather than the bcrypt/argon2 named in plan §11. Both of those are
 * native modules, which on a serverless target means a compiled binary in the
 * bundle and a build that breaks whenever the runtime's Node version moves.
 * scrypt is memory-hard, in the same family as argon2, and built into Node —
 * no dependency, nothing to compile, nothing to keep in step.
 *
 * If this ever moves to a long-lived server, argon2id is the better primitive
 * and `verify` below already carries the version tag needed to migrate hashes
 * lazily on next login.
 */

// ~32 MB per hash. High enough to make offline cracking expensive, low enough
// that a serverless function with a modest memory limit will not be killed.
const N = 32_768
const r = 8
const p = 1
const KEY_LENGTH = 64
const SALT_LENGTH = 16

const VERSION = 's1'

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  // Node's default maxmem is 32 MB, which N=32768 exceeds — without raising it
  // the call throws rather than quietly producing a weaker hash.
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: 128 * 1024 * 1024,
  })

  return `${VERSION}$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupt row
 * should fail the login, not 500 the endpoint and reveal that the account
 * exists.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [version, nRaw, rRaw, pRaw, saltRaw, hashRaw] = stored.split('$')
    if (version !== VERSION || !nRaw || !rRaw || !pRaw || !saltRaw || !hashRaw) return false

    const salt = Buffer.from(saltRaw, 'base64url')
    const expected = Buffer.from(hashRaw, 'base64url')

    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: 128 * 1024 * 1024,
    })

    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

/**
 * Burn roughly the same work as a real verification.
 *
 * Called when no account matches the submitted email. Without it, a missing
 * account returns in microseconds while a real one takes ~100 ms, and that gap
 * alone lets anyone enumerate which addresses are registered.
 */
export async function fakeVerify(): Promise<void> {
  await scrypt('placeholder', randomBytes(SALT_LENGTH), KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: 128 * 1024 * 1024,
  })
}
