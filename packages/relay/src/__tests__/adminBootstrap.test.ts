import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, getDb, closeDb } from '../db'
import { bootstrapAdminFromEnv, AdminBootstrapError, type BootstrapLogger } from '../lib/adminBootstrap'
import { verifyPassword, createAdminAccount } from '../lib/adminAccount'

// The first account for an install that cannot reach `POST /api/v1/auth/init`.
//
// That endpoint requires `resolveClient(req).isLocal`, which a container never satisfies — it is
// always behind its bridge gateway. Measured against the published image, the call answers 403 from
// the host's own browser and from the LAN alike, and the image carries no CLI to run instead
// (relay-only, by design). So a Docker install had no way to create an owner at all.

const PASSWORD = 'correct-horse-battery'

/** Both channels as one list, which is what the leak assertion has to search. */
function makeLogger() {
  const lines: { level: 'info' | 'warn' | 'error'; message: string }[] = []
  const logger: BootstrapLogger = {
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
  }
  const of = (level: string) => () => lines.filter((l) => l.level === level).map((l) => l.message)
  return { logger, lines, info: of('info'), warn: of('warn'), error: of('error'), all: () => lines.map((l) => l.message).join('\n') }
}

const users = () => getDb().prepare('SELECT email, role, password_hash FROM users').all() as
  { email: string; role: string; password_hash: string | null }[]

describe('bootstrapAdminFromEnv', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-admin-bootstrap-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    getDb().prepare('DELETE FROM users').run()
  })

  it('creates the first admin and names the email it used', () => {
    const log = makeLogger()
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, log.logger)

    const rows = users()
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('owner@example.com')
    expect(rows[0].role).toBe('Admin')
    expect(log.info()).toHaveLength(1)
    expect(log.info()[0]).toContain('owner@example.com')
  })

  it('produces a password that logs in, so the boot path and the HTTP path make the same account', () => {
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, makeLogger().logger)
    const hash = users()[0].password_hash
    expect(hash).toBeTruthy()
    expect(verifyPassword(PASSWORD, hash!)).toBe(true)
    expect(verifyPassword('not the password', hash!)).toBe(false)
  })

  it('does nothing at all when an owner already exists', () => {
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: 'first@example.com', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, makeLogger().logger)
    const before = users()

    // Second boot, different values: the account must not be replaced, and nothing may be logged —
    // otherwise a long-running install accumulates one line per restart. This is also why refusing
    // to boot below is safe: an install with an owner never reaches those branches, so a typo in
    // these variables cannot strand a relay that is already serving.
    const log = makeLogger()
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: 'second@example.com', TAPFLOW_ADMIN_PASSWORD: 'another-password' }, log.logger)

    expect(users()).toEqual(before)
    expect(log.lines).toHaveLength(0)
  })

  it('is silent when neither variable is set, which is every non-container install', () => {
    const log = makeLogger()
    bootstrapAdminFromEnv({}, log.logger)
    expect(users()).toHaveLength(0)
    expect(log.lines).toHaveLength(0)
  })

  // **Each row names the text it expects**, not just how many messages there were. Counting alone let
  // the diagnostic be inverted — swapping the ternary that picks which variable is missing tells the
  // operator to set the one they already set, and four rows of `toHaveLength(1)` stayed green.
  const REFUSED: Record<string, [Record<string, string>, string]> = {
    'only the email': [{ TAPFLOW_ADMIN_EMAIL: 'owner@example.com' }, 'TAPFLOW_ADMIN_PASSWORD is not set'],
    'only the password': [{ TAPFLOW_ADMIN_PASSWORD: PASSWORD }, 'TAPFLOW_ADMIN_EMAIL is not set'],
    'a password under 8 characters': [{ TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: 'short12' }, 'shorter than 8 characters'],
    'an email that is only whitespace': [{ TAPFLOW_ADMIN_EMAIL: '   ', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, 'TAPFLOW_ADMIN_EMAIL is not set'],
  }

  for (const [what, [env, expected]] of Object.entries(REFUSED)) {
    it(`refuses to boot given ${what}, and says which setting is wrong`, () => {
      const log = makeLogger()
      // Fail closed. The only state that reaches here is "an admin was asked for, there is none, and
      // the settings are wrong" — serving that leaves the install ownerless and claimable from
      // loopback for as long as nobody notices.
      expect(() => bootstrapAdminFromEnv(env, log.logger)).toThrow(AdminBootstrapError)
      expect(users()).toHaveLength(0)
      expect(log.error()).toHaveLength(1)
      expect(log.error()[0]).toContain(expected)
      expect(log.info()).toHaveLength(0)
    })
  }

  it('never writes the password to the log, on any path', () => {
    // **The one assertion here that is about absence**, so it is the one that can pass while broken.
    // Verified by mutation: adding the password to the success line fails this test and nothing else.
    const cases = [
      { TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: PASSWORD },
      { TAPFLOW_ADMIN_PASSWORD: PASSWORD },
      { TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: 'short12' },
    ]
    for (const env of cases) {
      getDb().prepare('DELETE FROM users').run()
      const log = makeLogger()
      try { bootstrapAdminFromEnv(env, log.logger) } catch { /* refusal is the point of two of these */ }
      expect(log.all(), JSON.stringify(env)).not.toContain(env.TAPFLOW_ADMIN_PASSWORD!)
    }
  })

  it('trims the email, so a stray newline from an env file does not become part of it', () => {
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: '  owner@example.com\n', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, makeLogger().logger)
    expect(users()[0].email).toBe('owner@example.com')
  })

  it('a duplicate email really does throw, which is what the race handler catches', () => {
    // The premise behind that handler, asserted rather than assumed: `users.email` is
    // `NOT NULL UNIQUE`, so when two replicas on one volume both read no owner, the second INSERT
    // raises. `bootstrapAdminFromEnv` catches it, re-checks, and returns — the install has an owner
    // either way, which is the outcome that was asked for.
    //
    // **The catch is not exercised end to end here.** Reaching it needs `isInitialized()` to be
    // false and the INSERT to conflict, which is two processes interleaving inside one call; a
    // single-process test can have one or the other. So this holds the half a unit can hold, and
    // the join is by reading `adminBootstrap.ts`.
    expect(createAdminAccount('owner@example.com', PASSWORD)).toBe('ok')
    expect(() => createAdminAccount('owner@example.com', PASSWORD)).toThrow(/UNIQUE/i)
    expect(users()).toHaveLength(1)
  })
})
