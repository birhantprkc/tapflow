// The download exists because the relay used to send its own filesystem path and the agent opened
// it — which works only when the two share a disk. What made that bug expensive was not the failure
// but the *message*: `unzip` said `cannot find or open`, the agent threw that away, and the user was
// told to check whether their archive was a real simulator build. It was.
//
// So these tests are mostly about telling failures apart. Every case names the mutation that kills it.
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BuildDownloadError, downloadBuild, httpOriginOf } from '../downloadBuild.js'

describe('httpOriginOf', () => {
  // Mutation: return `relayUrl` unchanged. The agent then requests a `ws://` URL over http and the
  // client throws on the protocol instead of downloading.
  it('maps the websocket schemes onto http', () => {
    expect(httpOriginOf('ws://192.168.1.5:4000')).toBe('http://192.168.1.5:4000')
    expect(httpOriginOf('wss://relay.example.com')).toBe('https://relay.example.com')
  })

  // Mutation: build the origin by string concatenation. `--relay` is user input and a trailing
  // slash is the most ordinary thing a person types; the request path would double its separator.
  it('drops a path, a query and a trailing slash', () => {
    expect(httpOriginOf('ws://host:4000/')).toBe('http://host:4000')
    expect(httpOriginOf('ws://host:4000/relay?token=x')).toBe('http://host:4000')
  })
})

describe('downloadBuild', () => {
  let dir: string
  let server: http.Server
  let port: number
  /** What the next request gets. Set per test. */
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-dl-test-'))
    server = http.createServer((req, res) => respond(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const relayUrl = () => `ws://127.0.0.1:${port}`
  const dest = () => path.join(dir, 'build.app.zip')

  it('writes the body and carries the ticket in a header', async () => {
    const body = Buffer.from('PK pretend archive')
    let seenTicket: string | undefined
    let seenUrl: string | undefined
    respond = (req, res) => {
      seenTicket = req.headers['x-tapflow-build-ticket'] as string
      seenUrl = req.url
      res.writeHead(200, { 'Content-Length': body.length })
      res.end(body)
    }

    await downloadBuild({ relayUrl: relayUrl(), ticket: 'abc123', destPath: dest(), expectedBytes: body.length })

    expect(fs.readFileSync(dest())).toEqual(body)
    expect(seenTicket).toBe('abc123')
    // Mutation: put the ticket in the path. `router.ts` logs `${method} ${url}` when a handler
    // throws and its redaction only knows PAT and JWT shapes, so a 64-char hex would land in the
    // relay's log and in every reverse proxy's access log on the way.
    expect(seenUrl).toBe('/api/v1/build-download')
    expect(seenUrl).not.toContain('abc123')
  })

  // **The case the whole change is about.** A cut-short transfer leaves a truncated archive, and
  // whoever extracts it is told the archive is bad — which is exactly the wrong sentence, because
  // the build is fine and the fix is to retry.
  //
  // Mutation: compare against `Content-Length` instead of `expectedBytes`. This server sends no
  // such header, so the check reads `undefined`, skips, and the truncated file is handed on.
  it('calls a short body a transfer failure, and says the archive is not damaged', async () => {
    respond = (_req, res) => { res.writeHead(200); res.end(Buffer.alloc(10)) }

    const err = await downloadBuild({
      relayUrl: relayUrl(), ticket: 't', destPath: dest(), expectedBytes: 5000,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BuildDownloadError)
    expect((err as Error).message).toContain('5000')
    expect((err as Error).message).toContain('10')
    expect((err as Error).message).toMatch(/not damaged/)
  })

  // Mutation: drop the status check and pipe whatever came. A JSON error body would be written to
  // disk with an archive's name and fail in `unzip`, putting the user back where they started.
  it.each([
    [410, /expired/i],
    [404, /deleted/i],
    [401, /version/i],
  ])('turns HTTP %i into a download failure that names it', async (status, wording) => {
    respond = (_req, res) => { res.writeHead(status); res.end('{"error":"nope"}') }

    const err = await downloadBuild({
      relayUrl: relayUrl(), ticket: 't', destPath: dest(), expectedBytes: 1,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BuildDownloadError)
    expect((err as Error).message).toContain(`HTTP ${status}`)
    expect((err as Error).message).toMatch(wording)
    expect(fs.existsSync(dest())).toBe(false)
  })

  // **The size check has to fire while the bytes are arriving, not after they land.** Checking only
  // on `finish` writes the whole body to disk first, and the idle timeout cannot help: it bounds a
  // transfer that *stopped*, not one that keeps coming. A file that grew between the relay's stat
  // and this request, or anything upstream sending an unbounded body, fills the agent's temp
  // directory before any number is compared.
  //
  // Mutation: move the comparison back to `finish`. The 4MB body is written in full first, so the
  // size assertion below is what fails.
  it('stops a body that runs past the size it was promised', async () => {
    const oversize = Buffer.alloc(4 * 1024 * 1024, 0x41)
    respond = (_req, res) => { res.writeHead(200); res.end(oversize) }

    const err = await downloadBuild({
      relayUrl: relayUrl(), ticket: 't', destPath: dest(), expectedBytes: 1024,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BuildDownloadError)
    expect((err as Error).message).toMatch(/larger than the relay said/)
    // Cut off rather than fully written: what reached disk is nowhere near the 4MB that was offered.
    const written = fs.existsSync(dest()) ? fs.statSync(dest()).size : 0
    expect(written).toBeLessThan(oversize.length)
  })

  // Mutation: remove `req.setTimeout`. `node:https` has no default, so this hangs forever — the
  // install promise never settles and the `finally` that deletes the temp directory never runs.
  it('gives up on a response that stops arriving', async () => {
    respond = (_req, res) => { res.writeHead(200, { 'Content-Length': 1000 }); res.write('x') /* and nothing more */ }

    const err = await downloadBuild({
      relayUrl: relayUrl(), ticket: 't', destPath: dest(), expectedBytes: 1000, idleTimeoutMs: 150,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BuildDownloadError)
    expect((err as Error).message).toMatch(/stalled/)
  })

  // Mutation: report a connection failure as an extraction problem. The relay being unreachable and
  // the archive being bad are the two things this change exists to stop confusing.
  it('names the relay when it cannot be reached at all', async () => {
    await new Promise<void>((r) => server.close(() => r()))

    const err = await downloadBuild({
      relayUrl: relayUrl(), ticket: 't', destPath: dest(), expectedBytes: 1,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BuildDownloadError)
    expect((err as Error).message).toMatch(/Could not reach the relay/)

    // The server is closed for the rest of this test; re-open a dummy so afterEach's close resolves.
    server = http.createServer(() => {})
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  })
})
