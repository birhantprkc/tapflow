import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../../lib/net-filter.js', async (actual) => ({
  ...(await actual<typeof import('../../lib/net-filter.js')>()),
  installNetFilter: vi.fn(),
}))

import { cmdMigrateNetFilter } from '../../commands/migrate.js'
import { installNetFilter } from '../../lib/net-filter.js'

const mockInstall = vi.mocked(installNetFilter)

/**
 * **What `tapflow migrate net-filter` exits with, per outcome.**
 *
 * This is a contract and not an implementation detail: a provisioning script runs this command and
 * branches on the code. v0.20.0 answered 0 for every outcome it could produce; `installed-unconfirmed`
 * is the first one that does not, and it covers a state that used to be reported as `installed` —
 * so a script that passed on 0.20.0 can fail on 0.21.0 for a Mac whose filter is slow to come up.
 *
 * That change is deliberate, because the old answer was a claim the command could not support. It is
 * pinned here because the release notes state it, and because #731 is an open question about whether
 * this exit code is right — whoever settles it needs to see which of the eleven outcomes were meant
 * as failures rather than infer it from a switch.
 */
const EXIT_CONTRACT: Record<string, 0 | 1> = {
  // Nothing is wrong, or the remaining step is a human's.
  installed: 0,
  'already-current': 0,
  'needs-approval': 0,
  'needs-reboot': 0,
  'not-macos': 0,
  // Something is wrong, or the command declines to guess.
  'installed-unconfirmed': 1,
  'no-artifact': 1,
  'refused-devices-busy': 1,
  'refused-host-unknown': 1,
  'refused-downgrade': 1,
  failed: 1,
}

/** The fields each outcome carries, so the banner renders rather than throwing on `undefined`. */
const OUTCOME: Record<string, Record<string, unknown>> = {
  installed: {},
  'installed-unconfirmed': {},
  'already-current': {},
  'needs-approval': { filterLeftDisabled: true },
  'needs-reboot': {},
  'not-macos': {},
  'no-artifact': {},
  'refused-devices-busy': { busy: ['simulator iPhone 17 Pro'] },
  'refused-host-unknown': { activated: '1787846299' },
  'refused-downgrade': { installed: '1788999999', shipped: '1788357869' },
  failed: { code: 3, detail: 'save refused', filterLeftDisabled: true },
}

describe('tapflow migrate net-filter — exit code contract', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it.each(Object.entries(EXIT_CONTRACT))('%s exits %d', (status, code) => {
    mockInstall.mockReturnValue({ status, ...OUTCOME[status] } as never)

    if (code === 0) {
      cmdMigrateNetFilter()
      expect(exitSpy, `${status} left the process with a failure code`).not.toHaveBeenCalled()
    } else {
      // **The throw is the assertion that it stopped.** `process.exit` is mocked, so without it the
      // switch would fall through and the next statement would run in a process the real command has
      // already left — which is how a `break` that should have been a `return` reads as passing.
      expect(() => { cmdMigrateNetFilter() }).toThrow('process.exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
    }
  })

  it('covers every outcome the command handles', () => {
    // **By inspection, because the union is erased at runtime.** `migrate.ts` has a `never`
    // exhaustiveness guard, so a new outcome cannot be forgotten there — but it can be given the
    // wrong exit code, and nothing above would notice a case this table never names.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands', 'migrate.ts'), 'utf8',
    )
    const body = src.slice(src.indexOf('export function cmdMigrateNetFilter'))
    const handled = [...body.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1])

    expect(handled.length, 'no cases were found — the regex stopped matching the source').toBeGreaterThan(5)
    expect(handled.sort()).toEqual(Object.keys(EXIT_CONTRACT).sort())
  })
})
