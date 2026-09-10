import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@tapflowio/relay', () => ({
  RelayServer: vi.fn().mockImplementation(function () { return ({
    start: vi.fn().mockResolvedValue(undefined),
  }) }),
  initDb: vi.fn(),
  loadedEnvPath: null,
  createCertProvider: vi.fn(),
  startTlsBackgroundTasks: vi.fn(() => () => {}),
  resolveRelayDisplayHost: vi.fn(() => 'localhost'),
  buildCorsOrigins: vi.fn(() => []),
  proxyWithoutPublicUrlWarning: vi.fn(() => null),
  config: { local: { port: 4000, dataDir: '/tmp/tapflow-test', wsBackpressureBytes: 1048576, trustedProxies: [] }, relay: { url: null }, tunnel: null, tls: null },
}))

const mockTunnel = { setupServer: vi.fn(), start: vi.fn(), stop: vi.fn() }
vi.mock('../../lib/rathole-tunnel.js', () => ({
  RatholeTunnel: vi.fn().mockImplementation(function () { return mockTunnel }),
}))
vi.mock('../../lib/tailscale-tunnel.js', () => ({
  TailscaleTunnel: vi.fn().mockImplementation(function () { return mockTunnel }),
}))

import { RelayServer, initDb, config, createCertProvider, resolveRelayDisplayHost, buildCorsOrigins, proxyWithoutPublicUrlWarning } from '@tapflowio/relay'
import { RatholeTunnel } from '../../lib/rathole-tunnel.js'
import { TailscaleTunnel } from '../../lib/tailscale-tunnel.js'
import { cmdRelayStart } from '../../commands/relay-start.js'

function agentConnectLine(output: string[]): string {
  const start = output.findIndex((entry) => entry.includes('tapflow agent start --relay'))
  expect(start).toBeGreaterThanOrEqual(0)
  const end = output.findIndex((entry, index) => index >= start && entry.includes('--token <agent-PAT>'))
  expect(end).toBeGreaterThanOrEqual(start)
  return output.slice(start, end + 1).join(' ')
}

describe('cmdRelayStart', () => {
  let output: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.mocked(RelayServer).mockImplementation(function () { return ({
      start: vi.fn().mockResolvedValue(undefined),
    } as never) })
    mockTunnel.setupServer.mockResolvedValue(undefined)
    mockTunnel.start.mockResolvedValue({ publicUrl: 'https://vps.example.com' })
    mockTunnel.stop.mockResolvedValue(undefined)
    vi.mocked(RatholeTunnel).mockImplementation(function () { return mockTunnel as never })
    vi.mocked(TailscaleTunnel).mockImplementation(function () { return mockTunnel as never })
    vi.mocked(config).tunnel = null
    vi.mocked(config).tls = null
  })

  afterEach(() => vi.restoreAllMocks())

  it('기본 포트 4000으로 RelayServer 기동', async () => {
    await cmdRelayStart({})
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }))
    expect(vi.mocked(RelayServer).mock.results[0]?.value.start).toHaveBeenCalled()
  })

  it('프록시 옵션(trustedProxies/corsOrigins)을 RelayServer에 전달', async () => {
    vi.mocked(buildCorsOrigins).mockReturnValue(['http://localhost:4000'])
    await cmdRelayStart({})
    expect(buildCorsOrigins).toHaveBeenCalled()
    expect(proxyWithoutPublicUrlWarning).toHaveBeenCalled()
    expect(RelayServer).toHaveBeenCalledWith(
      expect.objectContaining({ trustedProxies: [], corsOrigins: ['http://localhost:4000'] }),
    )
  })

  it('initDb가 RelayServer 생성 전에 호출됨', async () => {
    const callOrder: string[] = []
    vi.mocked(initDb).mockImplementation(() => { callOrder.push('initDb') })
    vi.mocked(RelayServer).mockImplementation(function () {
      callOrder.push('RelayServer')
      return { start: vi.fn().mockResolvedValue(undefined) } as never
    })

    await cmdRelayStart({})

    expect(callOrder.indexOf('initDb')).toBeLessThan(callOrder.indexOf('RelayServer'))
  })

  it('--port 옵션으로 포트 변경', async () => {
    await cmdRelayStart({ port: 8080 })
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 8080 }))
  })

  it('SIGINT 시 process.exit(0) 호출', async () => {
    const onSpy = vi.spyOn(process, 'on')
    await cmdRelayStart({})
    const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT')
    expect(call).toBeDefined()
    const handler = call![1] as () => void
    expect(() => handler()).toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('기동 완료 후 포트 번호가 출력에 포함됨', async () => {
    await cmdRelayStart({ port: 9999 })
    expect(output.join('\n')).toContain('9999')
  })

  it('기본 포트 출력에 localhost:4000 포함', async () => {
    await cmdRelayStart({})
    expect(output.join('\n')).toContain('localhost:4000')
  })

  it('import-cert 인증서의 DNS host를 출력', async () => {
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue('relay.example.com')

    await cmdRelayStart({})

    expect(resolveRelayDisplayHost).toHaveBeenCalledWith(config.tls, 'CERT', expect.any(Function))
    expect(output.join('\n')).toContain('https://relay.example.com:4000')
  })

  it('TLS agent-connect 안내에 인증서 host를 사용', async () => {
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue('relay.example.com')

    await cmdRelayStart({ port: 4321 })

    const line = agentConnectLine(output)
    expect(line).toContain('wss://relay.example.com:4321')
    expect(line).not.toContain('<host>')
  })

  it('HTTP agent-connect 안내는 host placeholder를 유지', async () => {
    await cmdRelayStart({})

    const line = agentConnectLine(output)
    expect(line).toContain('ws://<host>:4000')
    expect(line).not.toContain('ws://localhost:4000')
  })

  it.each(['localhost', 'Localhost'])('TLS host가 %s로 fallback되면 agent-connect 안내는 placeholder를 유지', async (displayHost) => {
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue(displayHost)

    await cmdRelayStart({})

    const line = agentConnectLine(output)
    expect(line).toContain('wss://<host>:4000')
    expect(line).not.toContain(`wss://${displayHost}:4000`)
  })

  it('Connect Mac agents 안내에 --token PAT와 발급처가 포함됨', async () => {
    await cmdRelayStart({})
    const out = output.join('\n')
    expect(out).toContain('--token <agent-PAT>')
    expect(out).toContain('Settings → Tokens')
  })

  it('포트 범위 초과(99999) → exit(1)', async () => {
    await expect(cmdRelayStart({ port: 99999 })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('포트 0 → exit(1)', async () => {
    await expect(cmdRelayStart({ port: 0 })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('NaN 포트 → exit(1)', async () => {
    await expect(cmdRelayStart({ port: NaN })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  describe('--tunnel 옵션', () => {
    beforeEach(() => {
      vi.stubEnv('TAPFLOW_TUNNEL_TOKEN', 'secret-token')
      vi.mocked(config).tunnel = { provider: 'rathole', serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', ssh: null }
    })

    afterEach(() => vi.unstubAllEnvs())

    it('config.tunnel 설정 → setupServer → start 순서 + 공개 URL 출력', async () => {
      const order: string[] = []
      mockTunnel.setupServer.mockImplementation(async () => { order.push('setupServer') })
      mockTunnel.start.mockImplementation(async () => { order.push('start'); return { publicUrl: 'https://vps.example.com' } })
      await cmdRelayStart({})
      expect(RatholeTunnel).toHaveBeenCalledWith(expect.objectContaining({ serverAddr: 'vps.example.com:2333', token: 'secret-token' }))
      expect(order).toEqual(['setupServer', 'start'])
      expect(output.join('\n')).toContain('https://vps.example.com')
    })

    it('--tunnel 플래그 없고 config.tunnel도 없음 → 터널 기동 안 함', async () => {
      vi.mocked(config).tunnel = null
      await cmdRelayStart({})
      expect(RatholeTunnel).not.toHaveBeenCalled()
    })

    it('TAPFLOW_TUNNEL_TOKEN 없음 → 터널 없이 relay 계속 (exit 안 함)', async () => {
      vi.unstubAllEnvs()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await cmdRelayStart({})
      expect(exitSpy).not.toHaveBeenCalled()
      expect(RatholeTunnel).not.toHaveBeenCalled()
      expect(RelayServer).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TAPFLOW_TUNNEL_TOKEN'))
    })

    it('SIGINT 시 relay + tunnel 모두 종료', async () => {
      const onSpy = vi.spyOn(process, 'on')
      await cmdRelayStart({})
      const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT')
      const handler = call![1] as () => void
      expect(() => handler()).toThrow('process.exit')
      expect(mockTunnel.stop).toHaveBeenCalled()
    })

    it('터널 기동 실패 → relay는 계속 동작', async () => {
      mockTunnel.start.mockRejectedValue(new Error('connection refused'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await cmdRelayStart({})
      expect(RelayServer).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'))
    })
  })

  describe('tailscale 터널', () => {
    beforeEach(() => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      mockTunnel.start.mockResolvedValue({ publicUrl: 'http://my-mac.tailnet.ts.net:4000' })
    })

    it('provider tailscale → TailscaleTunnel 생성, 토큰 불필요', async () => {
      await cmdRelayStart({})
      expect(TailscaleTunnel).toHaveBeenCalledWith({ publicUrl: undefined })
      expect(RatholeTunnel).not.toHaveBeenCalled()
      expect(output.join('\n')).toContain('my-mac.tailnet.ts.net')
    })

    it('TAPFLOW_TUNNEL_TOKEN 없어도 Tailscale 정상 기동', async () => {
      await expect(cmdRelayStart({})).resolves.toBeUndefined()
      expect(TailscaleTunnel).toHaveBeenCalled()
    })
  })
})
