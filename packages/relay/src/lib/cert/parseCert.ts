import { X509Certificate } from 'crypto'
import { isIP } from 'net'
import type { TlsConfig } from './createCertProvider.js'

const FALLBACK_HOST = 'localhost'
const IMPORT_CERT_FALLBACK_WARNING =
  'Imported certificate has DNS SANs, but none can be advertised to teammates; using localhost. ' +
  'Add a concrete non-localhost DNS SAN to advertise its URL.'

interface ParsedDisplayHost {
  host: string
  warnAboutFallback: boolean
}

function concreteDnsHost(value: string): string | null {
  if (!value || value !== value.trim() || isIP(value) !== 0 || value.length > 253) return null
  const labels = value.split('.')
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null
  try {
    // WHATWG URLs accept legacy IPv4 spellings such as 127.1 and 0x7f000001.
    // Do not advertise them as DNS names: browsers normalize them to an IP address.
    if (isIP(new URL(`https://${value}`).hostname) !== 0) return null
  } catch {
    return null
  }
  return value
}

/** PEM 인증서에서 notAfter(만료 시각)를 파싱한다. 잘못된 PEM이면 throw. */
export function parseCertNotAfter(certPem: string): Date {
  return new Date(new X509Certificate(certPem).validTo)
}

function parseCertDisplayHostResult(certPem: string): ParsedDisplayHost {
  try {
    const cert = new X509Certificate(certPem)
    if (cert.subjectAltName !== undefined) {
      let hasDnsSan = false
      // Node JSON-quotes and escapes ambiguous SAN values, including commas. A real DNS host uses
      // none of those characters, so strict label validation can safely reject the whole value.
      for (const entry of cert.subjectAltName.split(', ')) {
        if (!entry.startsWith('DNS:')) continue
        hasDnsSan = true
        const host = concreteDnsHost(entry.slice(4))
        if (host && host.toLowerCase() !== FALLBACK_HOST) {
          return { host, warnAboutFallback: false }
        }
      }
      return { host: FALLBACK_HOST, warnAboutFallback: hasDnsSan }
    }

    const commonName = cert.subject
      .split('\n')
      .find((entry) => entry.startsWith('CN='))
      ?.slice(3)
    return {
      host: commonName ? concreteDnsHost(commonName) ?? FALLBACK_HOST : FALLBACK_HOST,
      warnAboutFallback: false,
    }
  } catch {
    return { host: FALLBACK_HOST, warnAboutFallback: false }
  }
}

/** Return one concrete DNS host the certificate can identify, or localhost when it has none. */
export function parseCertDisplayHost(certPem: string): string {
  return parseCertDisplayHostResult(certPem).host
}

export function resolveRelayDisplayHost(
  tls: TlsConfig | null,
  certPem?: string,
  warn?: (message: string) => void,
): string {
  if (!tls) return FALLBACK_HOST
  if (tls.mode === 'byo-api-token') return tls.domain
  if (!certPem) return FALLBACK_HOST

  const result = parseCertDisplayHostResult(certPem)
  if (result.warnAboutFallback) warn?.(IMPORT_CERT_FALLBACK_WARNING)
  return result.host
}
