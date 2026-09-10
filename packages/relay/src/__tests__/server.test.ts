import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  initDb: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
  resolveRelayDisplayHost: vi.fn(() => 'relay.example.com'),
  tls: { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' } as const,
}))

vi.mock('@tapflowio/agent-core', () => ({
  createLogger: vi.fn(() => ({ info: mocks.info, warn: mocks.warn, error: mocks.error })),
}))
vi.mock('../db.js', () => ({ initDb: mocks.initDb }))
vi.mock('../RelayServer.js', () => ({
  RelayServer: vi.fn(function () { return { start: mocks.start, stop: mocks.stop } }),
}))
vi.mock('../lib/config.js', () => ({
  config: {
    local: { port: 4000, dataDir: '/tmp/tapflow-test', wsBackpressureBytes: 1048576, trustedProxies: [] },
    relay: { url: null },
    tunnel: null,
    tls: mocks.tls,
  },
  loadedEnvPath: null,
}))
vi.mock('../lib/proxyConfig.js', () => ({
  buildCorsOrigins: vi.fn(() => []),
  proxyWithoutPublicUrlWarning: vi.fn(() => null),
}))
vi.mock('../lib/cert/index.js', () => ({
  createCertProvider: vi.fn(() => ({ ensureCert: mocks.ensureCert })),
  resolveRelayDisplayHost: mocks.resolveRelayDisplayHost,
}))
vi.mock('../lib/tlsTasks.js', () => ({ startTlsBackgroundTasks: vi.fn(() => () => {}) }))

describe('relay server startup output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.spyOn(process, 'on').mockImplementation(() => process)
  })

  afterEach(() => vi.restoreAllMocks())

  it('uses the imported certificate host in the advertised URL', async () => {
    await import('../server.js')

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    expect(mocks.resolveRelayDisplayHost).toHaveBeenCalledWith(mocks.tls, 'CERT', expect.any(Function))
    expect(mocks.info).toHaveBeenCalledWith('tapflow relay running at https://relay.example.com:4000')
  })
})
