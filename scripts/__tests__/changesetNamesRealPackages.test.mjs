import { describe, expect, it } from 'vitest'
import { getPackages } from '@manypkg/get-packages'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// A changeset naming a package that does not exist stops `changeset version` dead:
//
//     Found changeset ios-reachability-hook for package @tapflowio/cli which is not in the workspace
//
// **And nothing before release day says so.** The CI `changeset` job asks whether a changeset
// *exists*, not whether it names anything real; `pnpm changeset:check` does the same. So the frontmatter
// is unread from the moment it is written until the release that consumes it — which is how
// `ios-reachability-hook.md` shipped naming `@tapflowio/cli`, a package whose actual name is `tapflow`.
// The CLI directory is `packages/cli`, so the wrong name is the natural guess and reads correct.
//
// It cost two releases rather than one: the fix was first made inside a release branch, that branch was
// abandoned, and the correction went with it — so the same error stopped the next cut too.
//
// **The enumerator is changesets' own**, for the reason its sibling `changesetIgnoresPrivate.test.mjs`
// gives: two of this workspace's packages are not under `packages/`, so a glob would declare a list
// complete while missing them. A check that reimplements a tool's discovery to guard that tool is a
// floor rather than a fence (`contributing/test-and-guard-coverage.md` §3).
const REPO = path.resolve(import.meta.dirname, '../..')
const workspace = await getPackages(REPO)
const known = new Set(workspace.packages.map((p) => p.packageJson.name))

/** Package names in a changeset's frontmatter — the `'name': bump` lines between the `---` fences. */
function namesIn(source) {
  const fence = source.indexOf('---', 3)
  if (!source.startsWith('---') || fence === -1) return []
  return source
    .slice(3, fence)
    .split('\n')
    .map((l) => /^\s*['"]?(@?[\w.\-/]+)['"]?\s*:\s*(major|minor|patch)\s*$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => m[1])
}

const dir = path.join(REPO, '.changeset')
const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')

describe('every changeset names a package this workspace has', () => {
  // Anti-vacuity: with no changesets pending the loop below asserts nothing, and "all of them are
  // valid" is true of an empty set. The parser is exercised against a known-good input either way.
  it('parses names out of frontmatter', () => {
    expect(namesIn("---\n'@tapflowio/relay': patch\n\"tapflow\": minor\n---\n\nbody\n"))
      .toEqual(['@tapflowio/relay', 'tapflow'])
    expect(namesIn('no frontmatter here')).toEqual([])
  })

  it('knows the workspace has at least the published packages', () => {
    expect(known.size).toBeGreaterThanOrEqual(9)
    expect(known.has('tapflow')).toBe(true)
    // The name that was got wrong. Stated so this test fails loudly if the CLI is ever renamed,
    // rather than quietly guarding a fact that stopped being true.
    expect(known.has('@tapflowio/cli')).toBe(false)
  })

  it.each(files.length ? files : ['(none pending)'])('%s', (file) => {
    if (file === '(none pending)') return
    const names = namesIn(readFileSync(path.join(dir, file), 'utf8'))
    const unknown = names.filter((n) => !known.has(n))
    expect(unknown, `${file} names ${unknown.join(', ')}, which this workspace does not have`).toEqual([])
  })
})
