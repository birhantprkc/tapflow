import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sources } from './sourceFiles.mjs'

const root = join(import.meta.dirname, '../..')
const agentCore = readFileSync(join(root, 'packages/agent-core/src/types.ts'), 'utf8')

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s*\/\/.*$/gm, '')
}

function stringLiterals(text) {
  return [...text.matchAll(/(['"])([^\r\n]*?)\1/g)].map((match) => match[2])
}

function agentCapabilities(text) {
  const match = withoutComments(text).match(/export type AgentCapability\s*=\s*([\s\S]*?)(?=\n\s*\n)/)
  expect(match, 'AgentCapability union did not parse').not.toBeNull()
  return new Set(stringLiterals(match[1]))
}

// This spelling floor only sees direct literal checks: aliases, constants, and template literals are
// deliberately outside its scope, so it is not a whole-program capability-consumer fence.
const capabilityCheck = /\b(?:agentCapabilities|(?:\w+\??\.)?capabilities)\??\.includes\(\s*(['"])([^\r\n]*?)\1\s*\)/g

function capabilityChecks(text) {
  return [...withoutComments(text).matchAll(capabilityCheck)].map((match) => match[2])
}

function dashboardCapabilityConsumers() {
  const consumers = []

  for (const file of sources('packages/dashboard')) {
    for (const capability of capabilityChecks(readFileSync(join(root, file), 'utf8'))) {
      consumers.push({ file, capability })
    }
  }

  return consumers
}

describe('dashboard capability consumers', () => {
  it('reports undeclared double-quoted capability checks', () => {
    const declared = agentCapabilities(agentCore)
    const consumers = capabilityChecks('agentCapabilities.includes("undeclared-capability")')

    expect(consumers).toEqual(['undeclared-capability'])
    expect(consumers.filter((capability) => !declared.has(capability))).toEqual(['undeclared-capability'])
  })

  it('only checks capabilities AgentCapability declares', () => {
    const declared = agentCapabilities(agentCore)
    const consumers = dashboardCapabilityConsumers()

    // An empty list proves no consumer was scanned, not that consumers agree. The cardinality also
    // catches a narrower matcher that loses one of the current selector/viewer forms.
    expect(consumers).toHaveLength(3)

    const unknown = consumers.filter(({ capability }) => !declared.has(capability))
    expect(unknown).toEqual([])
  })
})
