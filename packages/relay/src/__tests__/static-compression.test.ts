import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'

// node's http client does NOT auto-decode Content-Encoding, so res.body is the
// exact bytes the server sent — perfect for asserting which sibling was served.
function httpGet(
  port: number,
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: reqPath, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      })
      .on('error', reject)
  })
}

describe('static asset compression', () => {
  let server: RelayServer
  let port: number
  let pub: string
  let dbDir: string

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-comp-db-'))
    initDb(path.join(dbDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(dbDir, { recursive: true })
  })

  beforeEach(async () => {
    pub = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-pub-'))
    fs.mkdirSync(path.join(pub, 'assets'))
    fs.writeFileSync(path.join(pub, 'assets', 'app.js'), 'RAW_JS')
    fs.writeFileSync(path.join(pub, 'assets', 'app.js.br'), 'BR_BYTES')
    fs.writeFileSync(path.join(pub, 'assets', 'app.js.gz'), 'GZ_BYTES')
    fs.writeFileSync(path.join(pub, 'assets', 'plain.js'), 'PLAIN')
    fs.writeFileSync(path.join(pub, 'assets', 'gzip-only.js'), 'GZIP_RAW')
    fs.writeFileSync(path.join(pub, 'assets', 'gzip-only.js.gz'), 'GZIP_ONLY_BYTES')
    fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html>')
    server = new RelayServer({ port: 0, publicDir: pub })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(pub, { recursive: true })
  })

  it('serves the brotli sibling when the client accepts br and gzip', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'br, gzip' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers['content-type']).toContain('javascript')
    expect(res.headers['vary']).toBe('Accept-Encoding')
    expect(res.body).toBe('BR_BYTES')
  })

  it('serves the gzip sibling when only gzip is accepted', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'gzip' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers['content-type']).toContain('javascript')
    expect(res.headers['vary']).toBe('Accept-Encoding')
    expect(res.body).toBe('GZ_BYTES')
  })

  it('serves the gzip sibling when br is disabled with q=0', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'br;q=0, gzip' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.body).toBe('GZ_BYTES')
  })

  it('honours an explicit rejection over a permissive wildcard', async () => {
    // RFC 9110 §12.5.3: the more specific match wins. Taking the maximum across `br` and `*` — which
    // is what the first version did — answered 1 for a client that named brotli and refused it.
    //
    // **Mutation:** returning `Math.max(named, wildcard)` from `parseQuality` instead of preferring
    // the named coding must fail this test.
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'br;q=0, *;q=1' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).not.toBe('br')
    expect(res.body).not.toBe('BR_BYTES')
  })

  it('reads the q parameter without regard to its case', async () => {
    // RFC 9110 §5.6.6: parameter names are case-insensitive. `startsWith('q=')` missed `Q=`, fell
    // through to the default weight of 1, and served brotli to a client that had refused it — the
    // same defect as the wildcard case above, reached through a different door.
    //
    // **Mutation:** dropping `.toLowerCase()` from the parameter match must fail this test.
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'br;Q=0, gzip' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.body).toBe('GZ_BYTES')
  })

  it('sets Vary on an asset with no compressed sibling at all', async () => {
    // `Vary` is a cache-key declaration, not a description of this response: without it a shared
    // cache can store the uncompressed body and hand it to a client that accepts brotli. Deriving
    // it from "does a sibling exist" also cost a `stat` on every request, which is why it no longer
    // is derived.
    //
    // **Mutation:** making the header conditional again — on a sibling existing, or on the client
    // having accepted something — must fail this test.
    const res = await httpGet(port, '/assets/plain.js', { 'Accept-Encoding': 'identity' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['vary']).toBe('Accept-Encoding')
  })

  it('serves the raw asset when no encoding is accepted', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'identity' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toBe('RAW_JS')
  })

  it('does not serve compression when all encodings are disabled', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'br;q=0, gzip;q=0, identity' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toBe('RAW_JS')
  })

  it('sets Vary even when raw is served, since compressed siblings exist', async () => {
    const res = await httpGet(port, '/assets/app.js', { 'Accept-Encoding': 'identity' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['vary']).toBe('Accept-Encoding')
  })

  it('serves gzip when only .gz sibling exists', async () => {
    const res = await httpGet(port, '/assets/gzip-only.js', { 'Accept-Encoding': 'br, gzip' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.body).toBe('GZIP_ONLY_BYTES')
  })

  it('serves raw when no precompressed sibling exists', async () => {
    const res = await httpGet(port, '/assets/plain.js', { 'Accept-Encoding': 'br, gzip' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toBe('PLAIN')
  })

  it('marks hashed assets immutable', async () => {
    const res = await httpGet(port, '/assets/app.js', {})
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('marks index.html with no-cache', async () => {
    const rootRes = await httpGet(port, '/', {})
    expect(rootRes.headers['cache-control']).toBe('no-cache')

    const indexRes = await httpGet(port, '/index.html', {})
    expect(indexRes.headers['cache-control']).toBe('no-cache')

    const spaFallbackRes = await httpGet(port, '/dashboard/view', {})
    expect(spaFallbackRes.headers['cache-control']).toBe('no-cache')
  })
})
