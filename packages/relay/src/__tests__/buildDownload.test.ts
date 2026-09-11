// The relay hands an agent a ticket instead of its own filesystem path, and serves the build against
// that ticket. Two things here are easy to get wrong and invisible to a unit test:
//
//   - **The route has to be reachable.** `:id` compiles to `([^/]+)` and the router returns on the
//     first registered match, so a download path under `/api/v1/builds/` is swallowed by
//     `/api/v1/builds/:id`. A test that calls the handler directly cannot see that.
//   - **An unmatched `/api/` GET is not a 404.** It falls through to the SPA fallback and comes back
//     **200 with `index.html`**, so asserting on the status code would let the collision through.
//     These tests assert on the bytes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { BuildTicketStore, TICKET_TTL_MS } from '../lib/buildTickets'

/** The warn tests need a directory but never start a server, so they get their own. */
const tmpDirForWarn = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-warn-'))

function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('BuildTicketStore', () => {
  it('mints a 64-character hex ticket', () => {
    const store = new BuildTicketStore()
    expect(store.mint(1, '/x', 10)).toMatch(/^[0-9a-f]{64}$/)
  })

  // Mutation: leave the entry in the map after reading it. A ticket that survives its use is a
  // credential with a 180-second life instead of a single-shot one.
  it('redeems a ticket once', () => {
    const store = new BuildTicketStore()
    const t = store.mint(7, '/x', 10)
    expect(store.redeem(t)).toMatchObject({ buildId: 7, bytes: 10 })
    expect(store.redeem(t)).toBe('unknown')
  })

  // Mutation: answer `'unknown'` for an expired ticket too. The agent then tells the user the
  // ticket was never valid, when what happened is that it sat too long — different fix entirely.
  it('tells an expired ticket apart from one that never existed', () => {
    const store = new BuildTicketStore()
    const now = 1_000_000
    const t = store.mint(1, '/x', 10, now)
    expect(store.redeem(t, now + TICKET_TTL_MS + 1)).toBe('expired')
    expect(store.redeem('deadbeef', now)).toBe('unknown')
  })

  // **The anti-vacuity assertion is the first line.** Without it this passes when minting is broken
  // and the map was empty all along — `size === 0` is true for a store that never filled.
  //
  // Mutation: delete the sweep. Tickets nobody redeems accumulate for the life of the process, and
  // a session owner pressing install repeatedly is all it takes.
  it('sweeps tickets nobody redeemed', () => {
    const store = new BuildTicketStore()
    const now = 1_000_000
    store.mint(1, '/a', 1, now); store.mint(2, '/b', 1, now); store.mint(3, '/c', 1, now)
    expect(store.size).toBe(3)

    store.sweep(now + TICKET_TTL_MS + 1)
    expect(store.size).toBe(0)
  })
})

describe('GET /api/v1/build-download', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let buildFile: string
  const BODY = Buffer.from('PK pretend simulator build, but real bytes')

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-build-dl-'))
    buildFile = path.join(tmpDir, 'demo.app.zip')
    fs.writeFileSync(buildFile, BODY)
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0, uploadsDir: tmpDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => { await server.stop() })

  /** Reaches into the running server's store, which is what `app:install` would have minted from. */
  function mint(filePath = buildFile): string {
    const store = (server as unknown as { buildTickets: BuildTicketStore }).buildTickets
    // Size from the file when there is one. A ticket for a path that no longer exists is the input
    // to the missing-file case, so this must not stat unconditionally.
    const bytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
    return store.mint(1, filePath, bytes)
  }

  // **This is the routing test.** Asserting the body rather than the status is the point: register
  // the route under `/api/v1/builds/` instead and the request is captured by `:id`, or falls to the
  // SPA fallback — both of which answer 200, one with `index.html`.
  it('serves the build bytes, and they are the build rather than the dashboard', async () => {
    const res = await get(port, '/api/v1/build-download', { 'X-Tapflow-Build-Ticket': mint() })
    expect(res.body).toEqual(BODY)
    expect(res.body.toString()).not.toContain('<title>')
  })

  // Mutation: read the ticket from the query string. It then reaches the request log on the first
  // handler throw, and every proxy access log regardless.
  it('refuses a request with no ticket header', async () => {
    const res = await get(port, '/api/v1/build-download')
    expect(res.status).toBe(401)
    expect(res.body.toString()).toContain('X-Tapflow-Build-Ticket')
  })

  // Mutation: accept a PAT here as well. `agent` scope would then reach every build row one id at a
  // time, which is the objection that ruled the earlier design out.
  it('refuses a ticket that was already used', async () => {
    const ticket = mint()
    expect((await get(port, '/api/v1/build-download', { 'X-Tapflow-Build-Ticket': ticket })).body).toEqual(BODY)

    const second = await get(port, '/api/v1/build-download', { 'X-Tapflow-Build-Ticket': ticket })
    expect(second.status).toBe(404)
    expect(second.body.toString()).not.toContain('PK')
  })

  // Mutation: fall through to `statSync` without try/catch. A build row outlives its file whenever a
  // bind mount goes away or a purge half-ran, and the throw would leave the request unanswered.
  it('answers when the file has gone missing, rather than throwing', async () => {
    const res = await get(port, '/api/v1/build-download', {
      'X-Tapflow-Build-Ticket': mint(path.join(tmpDir, 'never-existed.zip')),
    })
    expect(res.status).toBe(404)
    expect(res.body.toString()).toMatch(/no longer on the relay/)
  })

  // A 200 with the dashboard's HTML is what a mis-registered route produces, so this pins the shape
  // the failure would take — the SPA fallback is real and it answers 200.
  it('does not answer the dashboard for a mistyped download path', async () => {
    const res = await get(port, '/api/v1/build-downloadx', { 'X-Tapflow-Build-Ticket': mint() })
    expect(res.body).not.toEqual(BODY)
  })
})

describe('the relay warns once about an agent that cannot download', () => {
  let server: RelayServer
  let warned: string[]
  let restore: () => void

  beforeEach(() => {
    server = new RelayServer({ port: 0, uploadsDir: tmpDirForWarn })
    warned = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')) }
    restore = () => { console.warn = original }
  })
  afterEach(() => { restore() })

  /** The real method, which is private — a reimplementation here would test nothing. */
  const warn = (identity: string, capabilities: string[]) =>
    (server as unknown as { warnLegacyInstaller(i: string, c: string[]): void })
      .warnLegacyInstaller(identity, capabilities)

  // Mutation: drop the `capabilities.includes` check and every agent gets told it is out of date.
  it('says nothing to an agent that can download', () => {
    warn('mac-b', ['clipboard', 'build-download'])
    expect(warned).toEqual([])
  })

  // Mutation: remove the `warnedLegacyInstaller` set. `agent:register` runs again on every
  // reconnect — the comment on that handler names a Wi-Fi blip and a laptop waking — so this would
  // repeat for the life of the relay.
  it('warns once per agent, not once per registration', () => {
    warn('mac-a', ['clipboard'])
    warn('mac-a', ['clipboard'])
    warn('mac-a', ['clipboard'])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('mac-a')
  })

  // **The wording is the finding.** Such an agent installs perfectly well beside its relay, and the
  // relay cannot tell which case this is — the dashboard hands out a LAN address even for the same
  // machine. Saying "installs will fail" would be false for most people who see it.
  //
  // Mutation: state it unconditionally. This assertion is what fails.
  it('makes the failure conditional on the agent being elsewhere', () => {
    warn('mac-c', [])
    expect(warned[0]).toMatch(/if it is not on the same machine/i)
    expect(warned[0]).toMatch(/update the agent/i)
  })

  it('keys on the identity, so a second agent is warned too', () => {
    warn('mac-a', [])
    warn('mac-b', [])
    expect(warned).toHaveLength(2)
  })
})
