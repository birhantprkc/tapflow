import fs from 'fs'
import http from 'http'
import https from 'https'
import { isLocalhostWss } from './utils/relayUrl.js'

/**
 * Thrown when the build could not be fetched. Distinct from an extraction failure **because the two
 * were indistinguishable and that was the bug**: the relay used to send its own filesystem path, the
 * agent handed it to `unzip`, and a file that was never there came back as
 * "check this is a simulator .app.zip" — so a perfectly good build looked corrupt.
 */
export class BuildDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildDownloadError'
  }
}

/**
 * How long the transfer may go without a byte arriving.
 *
 * An **idle** limit, not a total one: a large build over a slow link is slow, not stuck, and cutting
 * it off by total elapsed time would fail the transfers most worth completing. What this catches is
 * a half-open socket — the relay notices a dropped connection by heartbeat in about a minute, and
 * without a limit here `node:https` waits forever, so the install promise never settles and the
 * `finally` that deletes the temp directory never runs.
 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000

/** `ws://host` → `http://host`. `new URL(...).origin` drops any path, query or trailing slash. */
export function httpOriginOf(relayUrl: string): string {
  const u = new URL(relayUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol
  return u.origin
}

/**
 * Fetches one build to `destPath` using a ticket the relay minted for this install.
 *
 * **`node:https`, not `fetch`.** `tapflow start --tls` gives the agent `wss://localhost`, whose
 * certificate is issued for a real domain and so never matches that host — the WebSocket already
 * makes exactly this exception (`isLocalhostWss`), and `fetch` cannot: it takes no per-request
 * `rejectUnauthorized`, and `undici` is not a dependency here. Using `fetch` would have turned a
 * working local setup into a failing one.
 *
 * **Size is checked against `expectedBytes`, which came over the WebSocket**, not against
 * `Content-Length`. That header is hop-by-hop: a proxy or tunnel that re-chunks the response drops
 * it, and a check that reads an absent header passes while looking at nothing — leaving a truncated
 * archive to be reported as a bad archive, which is the failure one layer up that this replaces.
 */
export function downloadBuild(opts: {
  relayUrl: string
  ticket: string
  destPath: string
  expectedBytes: number
  idleTimeoutMs?: number
}): Promise<void> {
  const { relayUrl, ticket, destPath, expectedBytes } = opts
  const origin = httpOriginOf(relayUrl)
  const url = new URL('/api/v1/build-download', origin)
  const client = url.protocol === 'https:' ? https : http

  return new Promise<void>((resolve, reject) => {
    const req = client.request(url, {
      method: 'GET',
      headers: { 'X-Tapflow-Build-Ticket': ticket },
      ...(url.protocol === 'https:' && isLocalhostWss(relayUrl) ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status !== 200) {
        // Drained so the socket can be reused and the server is not left writing into nothing.
        res.resume()
        reject(new BuildDownloadError(
          `The relay refused to send the build (HTTP ${status}). ` +
          (status === 410 ? 'The download window expired — try installing again.'
            : status === 404 ? 'The build may have been deleted from the relay.'
            : 'Check that the relay and this agent are the same version.'),
        ))
        return
      }

      let received = 0
      const out = fs.createWriteStream(destPath)
      res.on('data', (chunk: Buffer) => { received += chunk.length })
      res.on('error', (err) => { out.destroy(); reject(new BuildDownloadError(`The build transfer failed: ${err.message}`)) })
      out.on('error', (err) => { res.destroy(); reject(new BuildDownloadError(`Could not write the build to disk: ${err.message}`)) })
      out.on('finish', () => {
        if (received !== expectedBytes) {
          reject(new BuildDownloadError(
            `The build arrived incomplete — expected ${expectedBytes} bytes, got ${received}. ` +
            'The archive is not damaged; the transfer was cut short. Try installing again.',
          ))
          return
        }
        resolve()
      })
      res.pipe(out)
    })

    req.setTimeout(opts.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      req.destroy(new BuildDownloadError('The build download stalled — no data arrived before the timeout.'))
    })
    req.on('error', (err) => {
      reject(err instanceof BuildDownloadError ? err : new BuildDownloadError(`Could not reach the relay to download the build: ${err.message}`))
    })
    req.end()
  })
}
