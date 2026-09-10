import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseCertDisplayHost, parseCertNotAfter, resolveRelayDisplayHost } from '../lib/cert/parseCert.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const certPem = fs.readFileSync(path.join(here, 'fixtures/tls-cert.pem'), 'utf-8')
const fixture = (name: string) => fs.readFileSync(path.join(here, `fixtures/${name}`), 'utf-8')

describe('parseCertNotAfter', () => {
  it('PEM에서 만료일을 Date로 파싱한다', () => {
    const exp = parseCertNotAfter(certPem)
    expect(exp).toBeInstanceOf(Date)
    expect(exp.getTime()).not.toBeNaN()
  })

  it('잘못된 PEM이면 throw', () => {
    expect(() => parseCertNotAfter('not a certificate')).toThrow()
  })
})

describe('parseCertDisplayHost', () => {
  it('uses the subject CN when the certificate has no SAN extension', () => {
    expect(parseCertDisplayHost(certPem)).toBe('tap.example.com')
  })

  it('skips non-DNS, wildcard, and IP SANs before the first concrete DNS name', () => {
    expect(parseCertDisplayHost(fixture('tls-cert-san-mixed.pem'))).toBe('relay.example.com')
  })

  it('skips localhost when a later DNS SAN is useful to teammates', () => {
    expect(parseCertDisplayHost(fixture('tls-cert-san-localhost-first.pem'))).toBe('tapflow.lan')
  })

  it.each([
    'tls-cert-cn-wildcard.pem',
    'tls-cert-san-wildcard.pem',
    'tls-cert-san-ip.pem',
    'tls-cert-san-ip-like.pem',
  ])(
    'uses localhost when %s cannot identify a concrete DNS host',
    (name) => {
      expect(parseCertDisplayHost(fixture(name))).toBe('localhost')
    },
  )

  it('does not split a quoted SAN value into a forged DNS entry', () => {
    expect(parseCertDisplayHost(fixture('tls-cert-san-quoted-comma.pem'))).toBe('localhost')
  })

  it('skips whitespace-padded DNS SANs without normalizing their identity', () => {
    expect(parseCertDisplayHost(fixture('tls-cert-san-whitespace.pem'))).toBe('valid.example.com')
  })

  it('falls back to localhost for malformed input', () => {
    expect(parseCertDisplayHost('not a certificate')).toBe('localhost')
  })
})

describe('resolveRelayDisplayHost', () => {
  it('uses the imported certificate host', () => {
    const tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' } as const
    expect(resolveRelayDisplayHost(tls, fixture('tls-cert-san-mixed.pem'))).toBe('relay.example.com')
  })

  it('warns once when imported DNS SANs cannot provide a teammate-ready host', () => {
    const tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' } as const
    const warn = vi.fn()

    expect(resolveRelayDisplayHost(tls, fixture('tls-cert-san-wildcard.pem'), warn)).toBe('localhost')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('concrete non-localhost DNS SAN'))
  })

  it.each([
    ['an IP-only SAN', fixture('tls-cert-san-ip.pem')],
    ['malformed certificate material', 'not a certificate'],
  ])('falls back without warning for %s', (_case, cert) => {
    const tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' } as const
    const warn = vi.fn()

    expect(resolveRelayDisplayHost(tls, cert, warn)).toBe('localhost')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the configured domain authoritative for managed certificates', () => {
    const tls = { mode: 'byo-api-token', domain: 'managed.example.com', dnsProvider: 'cloudflare' } as const
    expect(resolveRelayDisplayHost(tls, certPem)).toBe('managed.example.com')
  })

  it('uses localhost without TLS or certificate material', () => {
    const tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' } as const
    expect(resolveRelayDisplayHost(null, certPem)).toBe('localhost')
    expect(resolveRelayDisplayHost(tls)).toBe('localhost')
  })
})
