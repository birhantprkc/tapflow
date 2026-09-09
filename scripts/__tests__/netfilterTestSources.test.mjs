// `run-tests.sh` builds the netfilter's test bundle with `swiftc` directly — measured 1.9s a cycle
// against ~13.5s for one `xcodebuild test` launch, which is what makes running eighty-two mutations
// on every push affordable. `tests.yml` did not go with it: generating a real project is how you open
// these tests in Xcode and step through one, and losing that to save a file would be a bad trade.
//
// The cost of keeping both is that the source list now exists twice, and the failure it invites is
// quiet in the direction that matters. Add a pure file, wire it into `tests.yml`, forget the script —
// and every mutation aimed at it reports BUILD BROKE, which reads as the mutation having drifted
// rather than as the runner being wrong. The other direction is worse: the script compiles it, the
// mutations pass, and only the project nobody runs in CI is stale.
//
// **The script is asked, not modelled, and the first version of this file is why that sentence is
// here.** It reimplemented the script's rules in JavaScript — and got the one that mattered wrong,
// expanding `Tests/*.swift` through the same recursive walk it used for `tests.yml`'s `Tests`
// directory. A shell glob does not descend. Measured with a planted `Tests/Support/ExtraTests.swift`
// containing a test that cannot pass: xcodegen compiled it, `swiftc` did not, the suite stayed at 80
// tests and exited 0, and this check reported the two lists equal. A guard that re-derives what it is
// checking is asserting its own translation (`contributing/test-and-guard-coverage.md` rule 1), so
// `run-tests.sh --print-sources` exists and prints what it will actually hand the compiler.
//
// `tests.yml`'s side is still resolved here, because xcodegen is not going to be run to find out —
// but that side is a directory walk, which is what xcodegen does and what a `Tests` entry means.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NETFILTER = join(ROOT, 'packages', 'ios-agent', 'ios-netfilter')

/** Every `.swift` under a directory, recursively — what xcodegen does with a directory entry. */
function swiftUnder(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) swiftUnder(p, out)
    else if (e.name.endsWith('.swift')) out.push(p)
  }
  return out
}

/** `tests.yml`'s `sources:` entries as the files xcodegen would compile. */
function specSources() {
  const yaml = readFileSync(join(NETFILTER, 'tests.yml'), 'utf8')
  const block = yaml.match(/^ {4}sources:\n((?: {6}(?:#.*|- .+)\n)+)/m)
  expect(block, 'tests.yml: no `sources:` block at the expected indentation').not.toBeNull()
  const entries = [...block[1].matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1].trim())
  expect(entries.length, 'tests.yml: the `sources:` block parsed as empty').toBeGreaterThan(0)
  return entries.flatMap((e) => {
    const abs = join(NETFILTER, e)
    return statSync(abs).isDirectory() ? swiftUnder(abs) : [abs]
  })
}

/** What `run-tests.sh` will hand `swiftc`, from the script itself. */
function scriptSources() {
  const out = execFileSync(join(NETFILTER, 'run-tests.sh'), ['--print-sources'], {
    cwd: NETFILTER,
    encoding: 'utf8',
  })
  return out.split('\n').filter(Boolean).map((p) => join(NETFILTER, p))
}

const rel = (paths) => [...new Set(paths.map((p) => relative(NETFILTER, p)))].sort()

describe('the netfilter test bundle compiles the same files however it is built', () => {
  it('tests.yml and run-tests.sh resolve to one set of sources', () => {
    const spec = rel(specSources())
    // Set from the measured count, not a round number: two pure files plus seven test files. A
    // derivation that breaks and yields nothing would otherwise match vacuously on both sides.
    expect(spec.length).toBeGreaterThanOrEqual(9)
    expect(rel(scriptSources())).toEqual(spec)
  })

  it('a test file in a subdirectory reaches both, or neither', () => {
    // The case the first version of this check could not see. `tests.yml` names a directory and
    // xcodegen descends; the script used a glob that does not, so this asserts on the mechanism
    // rather than on today's flat tree — `find` is what makes it true, and reverting to a glob
    // fails here without needing anyone to plant a file first.
    const sh = readFileSync(join(NETFILTER, 'run-tests.sh'), 'utf8')
    expect(sh, 'run-tests.sh must gather Tests/ recursively, the way xcodegen walks it')
      .toMatch(/find\s+Tests\s+-name\s+'\*\.swift'/)
    expect(sh, 'a non-descending glob is what shipped the hole this check exists for')
      .not.toMatch(/SOURCES=\([^)]*Tests\/\*\.swift/)
  })

  it('both halves of the binary pair are in it', () => {
    // Neither target can be linked — a system extension is not loadable by a test bundle, and
    // `Host/main.swift` is top-level code whose statements would become a second `main` — so the
    // pure files are compiled into the bundle. Losing one silently drops a whole target's coverage.
    expect(rel(scriptSources())).toEqual(
      expect.arrayContaining(['Extension/FlowIdentity.swift', 'Host/RuleArguments.swift']),
    )
  })
})
