import { describe, it, expect } from 'vitest'
import { packagesNamedIn, mixedChangesets, ignoredOnlyChangesets, changelogEntryOwed, manifestChangeShips, shipsToUsers, packagePublishesAt } from '../check-changeset.mjs'

const IGNORED = new Set(['@tapflowio/dashboard', '@tapflowio/playground'])
const cs = (body) => `---\n${body}\n---\n\nsome note.\n`

describe('changeset frontmatter', () => {
  it('reads the packages a changeset bumps', () => {
    expect(packagesNamedIn(cs('"@tapflowio/relay": patch\n"@tapflowio/protocol": minor')))
      .toEqual(['@tapflowio/relay', '@tapflowio/protocol'])
  })
  it('returns nothing for a file with no frontmatter', () => {
    expect(packagesNamedIn('just prose\n')).toEqual([])
  })
})

describe('mixing an ignored package with a published one', () => {
  // What stopped the v0.18.0 release. `changeset version` rejects it outright, and until this
  // check the PR gate never opened a changeset to notice.
  const read = (f) => ({
    'mixed.md': cs('"@tapflowio/protocol": patch\n"@tapflowio/dashboard": patch'),
    'clean.md': cs('"@tapflowio/protocol": patch\n"@tapflowio/relay": patch'),
    'only-ignored.md': cs('"@tapflowio/dashboard": patch'),
  })[f]

  it('flags the mix, naming both sides', () => {
    const [hit] = mixedChangesets(['mixed.md'], IGNORED, read)
    expect(hit.file).toBe('mixed.md')
    expect(hit.ignored).toEqual(['@tapflowio/dashboard'])
    expect(hit.published).toEqual(['@tapflowio/protocol'])
  })
  it('leaves a published-only changeset alone', () => {
    expect(mixedChangesets(['clean.md'], IGNORED, read)).toEqual([])
  })
  // Not this check's business — the file is not *mixed*. It is still a defect, and a silent one, which
  // is why `ignoredOnlyChangesets` below exists. This assertion used to read as though the case were
  // fine; it only means `mixedChangesets` is right to pass it on.
  it('leaves an ignored-only changeset to the check below', () => {
    expect(mixedChangesets(['only-ignored.md'], IGNORED, read)).toEqual([])
  })
})

describe('a changeset that names only ignored packages', () => {
  // The quiet half. `changeset version` produces no release for it and deletes the file, so published
  // source ships with nothing written about it — and every gate was green. It is the mistake the root
  // AGENTS.md warns about by name: a dashboard change must name `@tapflowio/relay`.
  const read = (f) => ({
    'only-ignored.md': cs('"@tapflowio/dashboard": patch'),
    'both-ignored.md': cs('"@tapflowio/dashboard": patch\n"@tapflowio/playground": patch'),
    'clean.md': cs('"@tapflowio/relay": patch'),
    'mixed.md': cs('"@tapflowio/relay": patch\n"@tapflowio/dashboard": patch'),
    'no-frontmatter.md': 'just prose\n',
  })[f]

  it('flags a changeset whose only package is ignored', () => {
    expect(ignoredOnlyChangesets(['only-ignored.md'], IGNORED, read)).toEqual(['only-ignored.md'])
  })
  it('flags one that names several, all ignored', () => {
    expect(ignoredOnlyChangesets(['both-ignored.md'], IGNORED, read)).toEqual(['both-ignored.md'])
  })
  it('leaves a published changeset alone', () => {
    expect(ignoredOnlyChangesets(['clean.md'], IGNORED, read)).toEqual([])
  })
  // A mixed file is already rejected, louder and with both sides named. Flagging it here too would
  // report one defect twice and send the author to the wrong instruction.
  it('leaves a mixed changeset to the check above', () => {
    expect(ignoredOnlyChangesets(['mixed.md'], IGNORED, read)).toEqual([])
  })
  // Names nothing at all, so it cannot be *only* ignored. `packagesNamedIn` returns `[]` and
  // `[].every(...)` is true, which would make this the one input that fails for being empty.
  it('leaves a changeset with no frontmatter alone', () => {
    expect(ignoredOnlyChangesets(['no-frontmatter.md'], IGNORED, read)).toEqual([])
  })
})

describe('a changeset that owes the root CHANGELOG an entry', () => {
  // The root CHANGELOG is hand-written and had no gate, so it went four days and 22 merged PRs stale
  // while every one of those PRs carried a changeset. Opting out is a written decision, not a silence.
  const read = (f) => ({
    'plain.md': cs('"@tapflowio/relay": patch'),
    'internal.md': `${cs('"@tapflowio/protocol": patch')}\n<!-- changelog: internal — protocol typing, nothing observable -->\n`,
    'no-reason.md': `${cs('"@tapflowio/protocol": patch')}\n<!-- changelog: internal -->\n`,
    'mentions-it.md': `${cs('"@tapflowio/relay": patch')}\n\nSee the changelog: internal notes are not a marker.\n`,
    'backtick-fence.md': cs('"@tapflowio/relay": patch') + '\n```md\n<!-- changelog: internal -->\n```\n',
    'tilde-fence.md': `${cs('"@tapflowio/relay": patch')}\n~~~md\n<!-- changelog: internal -->\n~~~\n`,
    'long-backtick-fence.md': cs('"@tapflowio/relay": patch') + '\n````md\n```md\n<!-- changelog: internal -->\n```\n````\n',
    'mixed-fence.md': cs('"@tapflowio/relay": patch') + '\n```md\n~~~\n<!-- changelog: internal -->\n~~~\n```\n',
    'after-fence.md': cs('"@tapflowio/protocol": patch') + '\n```md\nexample\n```\n<!-- changelog: internal -->\n',
    'indented-fence.md': cs('"@tapflowio/protocol": patch') + '\n    ```md\n<!-- changelog: internal -->\n    ```\n',
    'indented-marker.md': `${cs('"@tapflowio/protocol": patch')}\n  <!-- changelog: internal -->  \n`,
    'indented-code-marker.md': `${cs('"@tapflowio/protocol": patch')}\nThe gate takes an opt-out:\n\n    <!-- changelog: internal -->\n`,
  })[f]

  it('owes one for a plain changeset', () => {
    expect(changelogEntryOwed(['plain.md'], read)).toEqual(['plain.md'])
  })
  it('is released by the marker', () => {
    expect(changelogEntryOwed(['internal.md'], read)).toEqual([])
  })
  // `internal` alone with no reason still opts out — the word is the marker and a bare one is a
  // decision someone typed. Requiring prose here would be a second, unstated rule.
  it('accepts the marker with no reason after it', () => {
    expect(changelogEntryOwed(['no-reason.md'], read)).toEqual([])
  })
  // Anchored to a line of its own, like `no-changeset`. Prose that happens to contain the words is not
  // an opt-out -- the shape this repo has been bitten by twice, where a comment was read as a value.
  it('is not released by prose that merely says the words', () => {
    expect(changelogEntryOwed(['mentions-it.md'], read)).toEqual(['mentions-it.md'])
  })
  it.each(['backtick-fence.md', 'tilde-fence.md', 'long-backtick-fence.md', 'mixed-fence.md'])('is not released by a marker inside %s', (file) => {
    expect(changelogEntryOwed([file], read)).toEqual([file])
  })
  it('is released by a marker after a closed fence', () => {
    expect(changelogEntryOwed(['after-fence.md'], read)).toEqual([])
  })
  it('is released by an unindented marker between four-space-indented fence-like lines', () => {
    expect(changelogEntryOwed(['indented-fence.md'], read)).toEqual([])
  })
  it('is released by the marker even with leading/trailing spaces', () => {
    expect(changelogEntryOwed(['indented-marker.md'], read)).toEqual([])
  })
  // The trim widened what counts as a marker, so what still must NOT count is worth pinning:
  // four spaces makes an indented code block -- someone quoting the syntax -- and `proseLines`
  // is now the only thing between that and a silent opt-out, since the match itself no longer
  // sees the indentation.
  it('is not released by a marker inside a four-space-indented code block', () => {
    expect(changelogEntryOwed(['indented-code-marker.md'], read)).toEqual(['indented-code-marker.md'])
  })
})

describe('a package.json edit that ships', () => {
  const withDev = (dev) => JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { a: '1' }, devDependencies: dev })
  it('ignores a devDependencies-only change', () => {
    // #453: wiring a private test helper into three consumers. The audit called it a missing
    // changeset while the PR gate had said the opposite about the same commit.
    expect(manifestChangeShips(withDev({}), withDev({ '@tapflowio/test-utils': 'workspace:*' }))).toBe(false)
  })
  it('catches a real dependency change', () => {
    const before = JSON.stringify({ name: 'x', dependencies: { a: '1' } })
    const after = JSON.stringify({ name: 'x', dependencies: { a: '2' } })
    expect(manifestChangeShips(before, after)).toBe(true)
  })
  it('treats an added or unparseable manifest as shipping', () => {
    expect(manifestChangeShips(null, withDev({}))).toBe(true)
    expect(manifestChangeShips('{ not json', withDev({}))).toBe(true)
  })

  it('ignores a pure key reordering', () => {
    // A formatter or `npm pkg set` can rewrite a manifest without changing a value. Compared as
    // raw JSON text those differ, and the gate would ask for a changeset nothing earned — the same
    // spurious signal this file exists to remove, arriving from the other side.
    const a = JSON.stringify({ name: 'x', version: '1', dependencies: { b: '1', a: '1' } })
    const b = JSON.stringify({ dependencies: { a: '1', b: '1' }, version: '1', name: 'x' })
    expect(manifestChangeShips(a, b)).toBe(false)
  })

  it('still sees a nested value change under reordered keys', () => {
    // Sorting must not be allowed to hide a real edit that happens to travel with a reorder.
    const a = JSON.stringify({ name: 'x', dependencies: { b: '1', a: '1' } })
    const b = JSON.stringify({ dependencies: { a: '2', b: '1' }, name: 'x' })
    expect(manifestChangeShips(a, b)).toBe(true)
  })

  it('still says shipping when BOTH sides are unparseable', () => {
    // The case the two above miss. Have the failure fall back to a placeholder instead of null
    // and they keep passing — the placeholder differs from the parsed side, so the comparison is
    // "changed" for the wrong reason. Only when both sides collapse to the same placeholder does
    // the answer flip to "nothing shipped", which is the dangerous direction. Measured.
    expect(manifestChangeShips('{ not json', 'also { not json')).toBe(true)
  })
})

describe('which packages ship', () => {
  // Read at a revision, never from disk: the audit walks history, so a package deleted since —
  // or introduced by the merge being examined — has to be judged as it was then. Reading the
  // working tree instead made every package that does not exist today look unpublished, which
  // broke eight existing cases at once, the new-package one among them.
  const manifest = (obj) => () => obj === null ? null : JSON.stringify(obj)

  it('excludes a private package', () => {
    expect(packagePublishesAt(manifest({ name: '@tapflowio/test-utils', private: true }), 'test-utils')).toBe(false)
  })
  it('includes the dashboard, which ships inside relay', () => {
    expect(packagePublishesAt(manifest({ name: '@tapflowio/dashboard', private: true }), 'dashboard')).toBe(true)
  })
  it('includes an ordinary published package', () => {
    expect(packagePublishesAt(manifest({ name: '@tapflowio/relay' }), 'relay')).toBe(true)
  })
  it('assumes a package it cannot read publishes — a new one must stay visible', () => {
    expect(packagePublishesAt(manifest(null), 'flow-capture')).toBe(true)
    expect(packagePublishesAt(() => '{ not json', 'relay')).toBe(true)
  })

  it('still excludes a directory under packages/ that is not a package', () => {
    expect(shipsToUsers('packages/docs/guide/requirements.md')).toBe(false)
  })
})
