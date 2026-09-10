import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// `bootstrapAdminFromEnv` is unit-tested, and its only call site was held by nothing: `server.ts` is
// a top-level side-effecting module no test imports, so deleting the call removed the whole Docker
// bootstrap with the relay suite fully green.
//
// By inspection rather than by booting, which is what the package can afford — the alternative is a
// harness around a module whose body runs on import. Read as: this asserts the wiring exists and is
// ordered, not that it works. What it does works is the file above's job.

const SERVER = path.join(import.meta.dirname, '..', 'server.ts')
const source = fs.readFileSync(SERVER, 'utf8')
const lineOf = (needle: string) => source.split('\n').findIndex((l) => l.includes(needle))

describe('server.ts wires the admin bootstrap', () => {
  it('calls it, with the process environment', () => {
    // Matched loosely on purpose. The first version pinned the whole import line and broke the
    // moment a second symbol was imported alongside it — an inspection test that fails on a
    // rearrangement it does not care about trains people to edit the test rather than read it.
    expect(source).toMatch(/import \{[^}]*\bbootstrapAdminFromEnv\b[^}]*\} from '\.\/lib\/adminBootstrap\.js'/)
    expect(source).toMatch(/bootstrapAdminFromEnv\(process\.env,\s*logger\)/)
  })

  it('calls it after the schema exists and before the server listens', () => {
    // `initDb` creates the singleton and runs migrations; `createAdminAccount` needs both. Serving
    // first would open a window where the HTTP bootstrap could race it.
    const initDb = lineOf('initDb(dbPath)')
    const bootstrap = lineOf('bootstrapAdminFromEnv(process.env')
    const start = lineOf('await server.start()')
    expect(initDb).toBeGreaterThan(-1)
    expect(bootstrap).toBeGreaterThan(initDb)
    expect(start).toBeGreaterThan(bootstrap)
  })

  it('exits rather than serving when the bootstrap refuses', () => {
    // Fail closed: the only way to reach a refusal is "an admin was asked for, there is none, and
    // the settings are wrong". Serving that leaves the install ownerless and claimable from
    // loopback. `bootstrapAdminFromEnv` throws; this is the half that must turn it into an exit.
    expect(source).toMatch(/catch[\s\S]{0,200}process\.exit\(1\)/)
  })

  it('scrubs the credentials from the environment after use', () => {
    // Every `spawnSync` in `api/builds.ts` — twelve, over user-uploaded archives — inherits
    // `process.env` without passing one explicitly. Nothing reads these names again.
    expect(source).toContain('delete process.env.TAPFLOW_ADMIN_PASSWORD')
    expect(source).toContain('delete process.env.TAPFLOW_ADMIN_EMAIL')
  })
})
