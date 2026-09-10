// The Docker workflow itself exercises normal runtime behavior on PRs. These checks only guard
// regressions CI cannot otherwise expose: CI could stay green while accidentally publishing a
// single-architecture image, and the digest smoke path cannot run in PR CI without maintainer
// registry credentials.
// The WebSocket guard only verifies that the smoke step still invokes the probe.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'docker-publish.yml'), 'utf8')
const DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf8')

function stepBlock(name) {
  const marker = `      - name: ${name}\n`
  const start = WORKFLOW.indexOf(marker)
  if (start === -1) return ''
  const next = WORKFLOW.indexOf('\n      - name:', start + marker.length)
  return WORKFLOW.slice(start, next === -1 ? undefined : next)
}

function matrixBlock() {
  const marker = '      matrix:\n'
  const start = WORKFLOW.indexOf(marker)
  if (start === -1) return ''
  const next = WORKFLOW.indexOf('\n    env:', start + marker.length)
  return WORKFLOW.slice(start, next === -1 ? undefined : next)
}

describe('docker-publish runtime smoke test', () => {
  it('keeps the Docker build matrix on the required amd64 and arm64 platforms', () => {
    const platforms = [...matrixBlock().matchAll(/platform:\s*(\S+)/g)].map(
      ([, platform]) => platform,
    )

    expect(platforms).toEqual(['linux/amd64', 'linux/arm64'])
  })

  it('smokes the pushed digest on the credentialed publish path', () => {
    const select = stepBlock('Select image for smoke test')
    expect(select).toContain('SMOKE_IMAGE=${IMAGE}@${{ steps.build.outputs.digest }}')
  })

  it('keeps the WebSocket upgrade probe in the smoke step', () => {
    const smoke = stepBlock('Smoke test image runtime')
    expect(smoke).toContain('node scripts/docker-publish-websocket-smoke.mjs')
  })

  it('excludes stale TypeScript incremental build metadata from Docker context', () => {
    expect(DOCKERIGNORE).toContain('**/*.tsbuildinfo')
  })
})
