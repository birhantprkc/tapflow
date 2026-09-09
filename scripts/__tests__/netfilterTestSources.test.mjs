// `run-tests.sh` builds the netfilter's test bundle with `swiftc` directly — measured 1.9s a cycle
// against ~13.5s for one `xcodebuild test` launch, which is what makes running eighty-two mutations
// on every push affordable. `tests.yml` did not go with it: generating a real project is how you open
// these tests in Xcode and step through one, and losing that to save a file would be a bad trade.
//
// The cost of keeping both is that the source list now exists twice, and the failure it invites is
// quiet in the direction that matters. Add a third pure file, wire it into `tests.yml`, forget the
// script — and every mutation aimed at it reports BUILD BROKE, which reads as the mutation having
// drifted rather than as the runner being wrong. The other direction is worse: the script compiles
// it, the mutations pass, and the Xcode project nobody runs in CI is the only thing that is stale.
//
// **Compared as file sets, not as text.** The two say it differently on purpose — `tests.yml` names
// the `Tests` directory because xcodegen walks it, the script globs `Tests/*.swift` because a shell
// does not recurse — so a spelling comparison would have to encode that difference and would then be
// asserting its own translation. Both sides are resolved against the disk instead, which is the
// question actually being asked: does the bundle Xcode builds contain what the mutations judge.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NETFILTER = join(ROOT, 'packages', 'ios-agent', 'ios-netfilter')

/** Every `.swift` under a directory, recursively. */
function swiftUnder(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) swiftUnder(p, out)
    else if (e.name.endsWith('.swift')) out.push(p)
  }
  return out
}

/** One source entry — a file, a directory, or a `*.swift` glob — as the files it stands for. */
function resolve(entry) {
  const abs = join(NETFILTER, entry.replace(/\/\*\.swift$/, ''))
  return statSync(abs).isDirectory() ? swiftUnder(abs) : [abs]
}

const asSet = (entries) =>
  [...new Set(entries.flatMap(resolve).map((p) => relative(NETFILTER, p)))].sort()

/** The `sources:` block of `tests.yml`'s single target. */
function specSources() {
  const yaml = readFileSync(join(NETFILTER, 'tests.yml'), 'utf8')
  const block = yaml.match(/^ {4}sources:\n((?: {6}(?:#.*|- .+)\n)+)/m)
  expect(block, 'tests.yml: no `sources:` block at the expected indentation').not.toBeNull()
  return [...block[1].matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1].trim())
}

/** The `SOURCES=(…)` array `run-tests.sh` hands to `swiftc`. */
function scriptSources() {
  const sh = readFileSync(join(NETFILTER, 'run-tests.sh'), 'utf8')
  const decl = sh.match(/^SOURCES=\(([^)]*)\)/m)
  expect(decl, 'run-tests.sh: no `SOURCES=(…)` declaration').not.toBeNull()
  return decl[1].split(/\s+/).filter(Boolean)
}

describe('the netfilter test bundle compiles the same files however it is built', () => {
  it('tests.yml and run-tests.sh resolve to one set of sources', () => {
    const spec = asSet(specSources())
    const script = asSet(scriptSources())
    // Set from the measured count, not a round number: two pure files plus the test tree. If a
    // derivation breaks and yields nothing, both sides match vacuously.
    expect(spec.length).toBeGreaterThanOrEqual(9)
    expect(script).toEqual(spec)
  })

  it('both halves of the binary pair are in it', () => {
    // Neither target can be linked — a system extension is not loadable by a test bundle, and
    // `Host/main.swift` is top-level code whose statements would become a second `main` — so the
    // pure files are compiled into the bundle. Losing one silently drops a whole target's coverage.
    expect(asSet(scriptSources())).toEqual(
      expect.arrayContaining(['Extension/FlowIdentity.swift', 'Host/RuleArguments.swift']),
    )
  })
})
