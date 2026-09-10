// `contributing/README.md`'s table is the directory's entry point, and nothing made it complete.
//
// The table is how a record is found when no rule beside the code happens to name it — 28 files, and
// a new one could be added with no row and nothing would say so. That is worth a check on its own,
// but the reason it is worth one *now* is that the table was just regrouped by subsystem: a grouped
// index is easier to read and easier to fall out of, because "which group does this go in" is a
// question an author can answer by not answering it.
//
// It also holds the one duplication in the scheme. Every row repeats the file's own frontmatter
// `type`, which is exactly the second copy that `contributing/README.md` warns about elsewhere — the
// duplication is safe only while something compares them.
//
// **Walked from disk, never `git ls-files`.** A record that was just written is untracked, and that
// is precisely the state a missing row is in. `checksWalkDisk.test.mjs` holds this for the whole
// family; see `sourceFiles.mjs` for the measurement behind it.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { proseLines } from '../lib/prose-lines.mjs'

const root = join(import.meta.dirname, '../..')
const dir = join(root, 'contributing')
/**
 * A document's prose lines, joined — the rows a reader would follow, without the ones a fenced or
 * indented example prints.
 *
 * **A row inside a fence is an illustration, not a registration.** Matching the whole document let
 * one populate the set and satisfy the completeness check for a record that has no real row;
 * measured on a planted `ghost-record.md`, which passed the README half. `proseLines` is the same
 * helper `issue-parent.mjs` uses to keep a quoted marker from switching a gate off — one copy, and
 * this is the third caller.
 */
const proseOf = (text) => [...proseLines(text)].map(({ line }) => line).join('\n')

/** `| [name.md](./name.md) | type | topics |` — the row shape, with the type captured. */
const ROW = /^\| \[([^\]]+\.md)\]\(\.\/([^)]+\.md)\) \| (\S+) \| .+ \|$/gm
/** The same, as `INDEX.md` writes it: the href carries the `contributing/` prefix. */
const INDEX_ROW = /^\|\s*\[[^\]]+\]\(\.\/contributing\/([^)]+\.md)\)/gm

const rowsIn = (text) => [...proseOf(text).matchAll(ROW)]
const indexedIn = (text) => new Set([...proseOf(text).matchAll(INDEX_ROW)].map((m) => m[1]))

const readme = readFileSync(join(dir, 'README.md'), 'utf8')
const index = readFileSync(join(root, 'INDEX.md'), 'utf8')

/** Every record in the directory. `README.md` is the index itself, not a record. */
const records = readdirSync(dir)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .sort()

const rowMatches = rowsIn(readme)
const rows = new Map(rowMatches.map((m) => [m[1], { href: m[2], type: m[3] }]))

/**
 * The records the root `INDEX.md` registers, read as **table rows** rather than as text anywhere.
 *
 * Searching the raw file for the path made the assertion satisfiable by a mention: a description
 * naming another record, or a fenced example, and the row it is supposed to prove need never exist.
 * Today every mention happens to be a row — measured, all 28 — which is exactly the state in which
 * a check like this reads as working.
 */
const indexed = indexedIn(index)

/** The `type:` line from a record's own frontmatter. */
function declaredType(file) {
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, file), 'utf8'))
  return m ? (/^type:\s*(\S+)/m.exec(m[1])?.[1] ?? null) : null
}

describe('every record is reachable from the index', () => {
  it('has a row in the README table', () => {
    // Named rather than counted: a failure should say which file to add, not that a number moved.
    expect(records.filter((f) => !rows.has(f))).toEqual([])
  })

  it('has a row in the root INDEX.md', () => {
    expect(records.filter((f) => !indexed.has(f))).toEqual([])
  })

  it('is linked by its own name, so a renamed file breaks the row rather than pointing elsewhere', () => {
    expect([...rows].filter(([name, { href }]) => href !== name).map(([n]) => n)).toEqual([])
  })
})

describe('the indexes do not describe files that are not there', () => {
  it('the README table lists no record that has been deleted or renamed', () => {
    expect([...rows.keys()].filter((f) => !records.includes(f))).toEqual([])
  })

  it('INDEX.md lists none either', () => {
    // Held in both directions on both indexes. Walking only the files that exist can say a record
    // is registered; it can never say a registration still has a record behind it, so a deleted
    // one leaves its row in place with nothing able to notice.
    expect([...indexed].filter((f) => !records.includes(f))).toEqual([])
  })

  it('does not accept a row printed inside a fenced example', () => {
    // An illustration is not a registration. Matching the whole document let a fenced row populate
    // the set, so a record with no real row satisfied the completeness check — planted as
    // `ghost-record.md`, it passed the README half. Asserted on the parsing rather than by editing
    // the committed file, which a test cannot do to prove a negative.
    const doc = [
      '| File | type | topics |',
      '|------|------|--------|',
      '| [real.md](./real.md) | rationale | x |',
      '',
      '```markdown',
      '| [fenced.md](./fenced.md) | rationale | x |',
      '```',
      '',
      '    | [indented.md](./indented.md) | rationale | x |',
    ].join('\n')
    expect(rowsIn(doc).map((m) => m[1]), 'the README shape').toEqual(['real.md'])
    const idx = doc.replace(/\]\(\.\//g, '](./contributing/')
    expect([...indexedIn(idx)], 'and the INDEX.md shape').toEqual(['real.md'])
  })

  it('lists each record once, not once per group it could belong to', () => {
    // The table is grouped now, so a record can be filed in two groups — and a Map keyed on the
    // filename collapses the second row into the first, which every other assertion here is happy
    // with. Counted from the raw matches, which is the only place the duplicate still exists.
    const counts = new Map()
    for (const [, name] of rowMatches) counts.set(name, (counts.get(name) ?? 0) + 1)
    expect([...counts].filter(([, n]) => n > 1).map(([f]) => f)).toEqual([])
  })

  it('repeats each record’s own frontmatter type', () => {
    // The row's `type` is a copy. It is allowed to exist because this compares it; without that the
    // two drift and the table starts describing a document that changed underneath it.
    const drifted = records
      .map((f) => ({ file: f, row: rows.get(f)?.type, declared: declaredType(f) }))
      .filter(({ row, declared }) => row !== declared)
    expect(drifted).toEqual([])
  })
})

describe('the check is looking at something', () => {
  it('found at least the records that existed when this was written', () => {
    // **An anti-vacuity floor set from the measured count, not a round number.** An empty `records`
    // or an empty `rows` satisfies every assertion above by having nothing to disagree about — which
    // is what a wrong glob or a changed row shape produces, silently.
    //
    // A floor rather than an equality, deliberately. Exact equality would fail every correctly
    // registered new record, and the chore it creates buys nothing the assertions above do not
    // already do: a row the regex stops matching is named by the completeness check before any
    // count notices, and a duplicate collapses at the same number either way. The one job left is
    // catching *nothing at all*, and a floor catches that.
    expect(records.length).toBeGreaterThanOrEqual(28)
    expect(rows.size).toBeGreaterThanOrEqual(28)
    expect(indexed.size).toBeGreaterThanOrEqual(28)
  })
})
