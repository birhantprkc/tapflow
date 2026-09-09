// Three places state how many mutations `--mutate` runs, and the number is what says whether the
// job fits its timeout: `ci.yml` names it twice (the count, and the count plus a baseline as build
// cycles) and `ios-agent/AGENTS.md` once. All three have gone stale, and the last time was inside the
// PR that added the mutations — the count was corrected in the first commit and the review-fix commit
// added four more without touching it.
//
// **The injected library's count used to be checked here and no longer is.** `ci.yml` stated it only
// as the argument for replacing layer 1's engine — layer 2 never invoked `xcodebuild`, which is why
// its twenty-six mutations took fifteen seconds. That argument was acted on, the sentence went with
// it, and nothing else states the number: no timeout is sized from it. Putting the sentence back so
// this file has something to assert would be inventing the thing being checked.
//
// **The prose already carries a warning about this, and the warning is what failed.** `ci.yml` says
// a version of that comment "said thirty-six when it was thirty-four", and `AGENTS.md` repeats the
// grep that gets it right. Both were written by someone who had just been bitten, and the drift
// happened twice more. That is `contributing/test-and-guard-coverage.md` rule 1 exactly: writing the
// lesson down reads as having applied it. So this is a check rather than a fourth sentence.
//
// **It is a spelling assertion, and rule 3 says that is a floor rather than a fence.** It cannot
// catch prose that states the count some other way, and it is not trying to — nobody hides a
// mutation count on purpose. What it catches is forgetting, which is the only way all three drifted.
// Two things keep it from passing vacuously: each site is matched for its *anchor* first, so
// rewording goes red instead of matching nothing, and the count is compared as a captured word
// rather than searched for, so a stale number names both halves in the failure.
//
// **The anchors match runs of whitespace rather than single spaces**, because two of these sentences
// wrap — and `ci.yml`'s wraps across a `# ` comment marker, so what sits between two words there is
// not a space at all. Do not "simplify" them back to literal spaces: besides breaking on the next
// reflow, `sources (` as literal text is what `checksWalkDisk` looks for, and this file would be
// reported as enumerating the tree from git.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

const LAYER1 = 'packages/ios-agent/ios-netfilter/run-tests.sh'

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** English for 0–999. The prose spells its numbers, so the comparison has to. */
function words(n) {
  if (n < 20) return ONES[n]
  if (n < 100) return n % 10 === 0 ? TENS[Math.floor(n / 10)] : `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}`
  const rest = n % 100
  return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${words(rest)}` : ''}`
}

/**
 * The mutations a script declares. `^mutate "` and not `^mutate `, which also matches the function
 * definition — the exact off-by-one both files warn about.
 */
function mutationCount(script) {
  const lines = read(script).split('\n')
  const declared = lines.filter((l) => /^mutate "/.test(l)).length
  const loose = lines.filter((l) => /^mutate /.test(l)).length
  // The definition is the only `^mutate ` that is not a declaration. If that stops being true the
  // count above is measuring something else and this check has quietly changed subject.
  expect(loose - declared, `${script}: expected exactly one non-declaration \`mutate \` line`).toBe(1)
  expect(declared).toBeGreaterThan(0)
  return declared
}

/** The word this site states, or a failure naming the anchor that is missing. */
function stated(file, anchor) {
  const m = read(file).match(anchor)
  expect(m, `${file}: nothing matched ${anchor} — reword the check with the prose`).not.toBeNull()
  return m[1]
}

describe('the stated mutation counts are the ones the scripts run', () => {
  it('ci.yml states the netfilter count and its launches', () => {
    const n = mutationCount(LAYER1)
    const file = '.github/workflows/ci.yml'
    expect(stated(file, /breaks[\s#]+the[\s#]+sources[\s#]+([a-z-]+)[\s#]+ways/)).toBe(words(n))
    // One baseline runs before the mutations, so the cycles are always one more.
    expect(stated(file, /#\s+([a-z-]+)\s+`swiftc`\s+build-and-run\s+cycles/)).toBe(words(n + 1))
  })

  it('ios-agent/AGENTS.md states the netfilter count', () => {
    expect(stated('packages/ios-agent/AGENTS.md', /breaks\s+the\s+sources\s+([a-z-]+)\s+ways/))
      .toBe(words(mutationCount(LAYER1)))
  })
})
