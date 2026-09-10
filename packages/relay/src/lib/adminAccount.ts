import crypto from 'crypto'
import { getDb } from '../db.js'

// The first-owner rules, and the password hashing they need.
//
// **Why this is in `lib/` and not beside the HTTP handlers.** Two callers need it: `api/auth.ts`
// serves `POST /api/v1/auth/init`, and `lib/adminBootstrap.ts` creates the first account at boot for
// a container, which cannot reach that endpoint at all — it requires a local client and a container
// is always behind its bridge gateway. A `lib/` module importing `api/` is backwards here, and doing
// it made `isInitialized` read as `undefined` depending on which module the test runner loaded
// first: green on its own file, nine failures in the full suite.

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex')
}

export function makePasswordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = hashPassword(password, salt)
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const computed = Buffer.from(hashPassword(password, salt), 'hex')
  const expected = Buffer.from(hash, 'hex')
  // 저장 해시 포맷 손상 시 길이 불일치로 timingSafeEqual이 RangeError → 안전 실패로 처리.
  if (computed.length !== expected.length) return false
  return crypto.timingSafeEqual(computed, expected)
}

/**
 * Does this install have an owner yet?
 *
 * Shared so the two bootstrap paths cannot disagree about what "already initialized" means.
 *
 * They are not identical in every respect: the boot path trims `TAPFLOW_ADMIN_EMAIL` and the HTTP
 * one stores `body.email` as sent, so the same address with surrounding whitespace produces two
 * different rows and the HTTP one never matches `handleLogin`'s `WHERE email = ?`. Normalising
 * inside this function would change what a shipped endpoint stores, so it is a decision rather than
 * a fix here — tracked separately.
 */
export function isInitialized(): boolean {
  const { n } = getDb().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
  return n > 0
}

/** Why `createAdminAccount` refused, or `ok`. The caller turns this into an HTTP status or a log line. */
export type CreateAdminResult = 'ok' | 'missing-fields' | 'password-too-short'

/**
 * Create the first Admin.
 *
 * Does **not** check whether an owner already exists — callers do, because they answer that case
 * differently: 403 over HTTP, a silent no-op on every restart at boot.
 */
export function createAdminAccount(email: string, password: string): CreateAdminResult {
  if (!email || !password) return 'missing-fields'
  if (password.length < 8) return 'password-too-short'
  getDb()
    .prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run(email, 'Admin', 'Admin', makePasswordHash(password))
  return 'ok'
}
