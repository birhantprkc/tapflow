// `protect-main` requires a status check named `ci`. A matrix job cannot carry that name — it
// reports per-leg contexts (`test (22)`, `test (24)`) and never a plain `ci` — so the matrix lives
// in `test` and a `ci` job aggregates it.
//
// That trade has a cost worth guarding. Before it, adding a job to ci.yml meant registering the new
// context on the ruleset by hand, and forgetting was visible: the check simply was not required.
// Now a new job that nobody adds to `jobs.ci.needs` is invisible — it can go red while `ci` stays
// green and the merge is allowed. The omission moved from repo settings, where review could not see
// it, into a `needs:` line, where review *can* — but only if someone looks.
//
// `changeset` is excluded because it is separately named on the ruleset. Anything else must be
// behind the aggregate.
//
// Parsed with a narrow regex rather than a YAML library: nothing at the root resolves `yaml`, and
// adding a dependency to read one field is a worse trade than a parser that only understands the
// two-space job indentation this file actually uses. It asserts that shape first, so a reformat
// fails loudly instead of silently matching nothing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

/** Top-level keys under `jobs:` — two-space indent, nothing deeper. */
function jobNames(yaml) {
  const body = yaml.slice(yaml.indexOf('\njobs:') + 1)
  return [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1])
}

/** The `needs:` of the `ci` job, in either the `[a, b]` or the block-list form. */
function ciNeeds(yaml) {
  const block = yaml.slice(yaml.indexOf('\n  ci:'))
  const inline = block.match(/^ {4}needs:\s*\[([^\]]*)\]/m)
  if (inline) return inline[1].split(',').map((s) => s.trim()).filter(Boolean)
  const list = block.match(/^ {4}needs:\n((?: {6}- .+\n)+)/m)
  return list ? [...list[1].matchAll(/- (.+)/g)].map((m) => m[1].trim()) : []
}

const SEPARATELY_REQUIRED = ['changeset']

describe('every CI job is behind the required `ci` aggregate', () => {
  it('the workflow parses — jobs are found', () => {
    // If a reformat breaks the assumption above, fail here rather than passing vacuously with an
    // empty job list, which would make every assertion below trivially true.
    expect(jobNames(CI).length).toBeGreaterThan(1)
    expect(jobNames(CI)).toContain('ci')
  })

  it('`ci` needs every other job except the separately-required ones', () => {
    const needs = ciNeeds(CI)
    const uncovered = jobNames(CI).filter(
      (j) => j !== 'ci' && !SEPARATELY_REQUIRED.includes(j) && !needs.includes(j),
    )
    expect(uncovered).toEqual([])
  })

  it('`ci` runs even when what it gates failed, and asserts the result', () => {
    const block = CI.slice(CI.indexOf('\n  ci:'))
    // Both are load bearing. Without `always()` this job is SKIPPED when `test` fails, and a
    // skipped required check counts as passing. Without the assertion it has no step that can
    // fail. Either omission makes the gate decorative while still looking present.
    expect(block).toMatch(/^ {4}if: always\(\)$/m)
    expect(block).toMatch(/needs\.test\.result.*=.*success/)
  })

  it('`ci` accepts a skipped `test-swift` only on the gate\'s own say-so', () => {
    const block = CI.slice(CI.indexOf('\n  ci:'))
    // `test-swift` may legitimately not run — it is gated on whether the netfilter moved. That makes
    // it the one leg whose absence has to be argued for rather than assumed, and a required check
    // counts a skip as a pass. Three things have to be present together: the leg is still asserted
    // to succeed in the normal case, a non-success is only tolerated when it is exactly `skipped`,
    // and the gate's own output has to say why. Dropping any one of them lets a cancelled runner or
    // a mistyped `if:` read as green, which is the failure the test above exists to prevent, one job
    // over. Measured before this was written: deleting the whole conditional left this file at 4/4.
    expect(block, 'the success case is no longer asserted').toMatch(/needs\['test-swift'\]\.result.*=.*success/)
    expect(block, 'any non-success is tolerated, not only a skip').toMatch(/=\s*"skipped"/)
    expect(block, 'a skip is accepted without the gate explaining it').toMatch(/needs\.changes\.outputs\.netfilter.*=.*"false"/)
    // And the gate itself: a failed `changes` leaves that output empty, which must not read as false.
    expect(block, 'the gate job is not required to have succeeded').toMatch(/needs\.changes\.result.*=.*success/)
  })

  it('no job or step opts out of failing', () => {
    // `continue-on-error` is the one hole that survives the aggregate: the leg reports success and
    // the rollup believes it. It is why the `alls-green` action exists.
    expect(CI).not.toContain('continue-on-error')
  })
})
