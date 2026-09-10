// `README.md` and `packages/cli/README.md` are the same document. The cli copy is what npm renders
// on the package page, and nothing tied the two together — #601 edited a hero and had to change both
// by hand, with no gate to say so if only one had been touched.
//
// The comparison normalises the two URL prefixes npm needs and skips regions both files mark as
// deliberately divergent. That makes the markers the hole rather than the fix: the check's core
// operation is "stop looking here", so much of what follows is aimed at the ways that instruction can
// be wrong. Per contributing/test-and-guard-coverage.md:
//
//   - An unbalanced marker throws rather than widening what is skipped. A line that is not
//     marker-shaped is not a marker at all — it stays in the comparison, which fails loudly rather
//     than quietly exempting anything. Both readings are asserted against synthetic input, since a
//     test cannot delete a marker from the committed files to prove it.
//   - Equality is paired with assertions that fail on a wrong value rather than on silence. The
//     rewrites must fire; the root copy must contain none of them; and every link the cli copy
//     carries must already be absolute, which is the property "the cli absolutises its links" stated
//     per link instead of as a total.
//   - Values that describe today's files are labelled as measured, so a failure tells the reader
//     whether to change the README back or move the number in the same diff.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const PAIR = [
  { label: 'root', path: 'README.md' },
  { label: 'cli', path: 'packages/cli/README.md' },
]

// Literal prefixes, deliberately not a link-shaped pattern. npm resolves neither repo-relative
// paths nor `blob/main` links, so the cli copy absolutises both; everything else about a link still
// has to match. The cost is that the root README cannot itself write one of these URLs on purpose —
// see #605.
const REWRITES = [
  'https://raw.githubusercontent.com/jo-duchan/tapflow/main/',
  'https://github.com/jo-duchan/tapflow/blob/main/',
]

// `\r?$` because the repo has no `.gitattributes`: a checkout with `core.autocrlf=true` ends every
// line with a carriage return, and without this the markers stop being markers. The failure that
// produced would be `expected [] to deeply equal [ 'npm-has-no-video' ]`, which names nothing.
const OPEN = /^<!-- readme-sync:exempt(?: ([a-z0-9-]+))? -->\r?$/
const CLOSE = /^<!-- \/readme-sync:exempt -->\r?$/

// Every link target a README carries: inline markdown, reference definitions, and raw HTML in
// either quote style. A floor, not a fence — this is regex extraction, so it does not survive
// deliberate obfuscation, and the count assertion below is what catches it silently matching
// nothing. Parsing the markdown properly was weighed and refused: it buys coverage of forms this
// document does not use, at the price of a parser dependency in a scripts guard.
// The HTML half allows whitespace around `=` and an unquoted value, both of which are valid and
// neither of which a hand-written `<a href=/guide>` announces as unusual.
export const LINK_TARGETS = (text) => [
  ...[...text.matchAll(/\]\(\s*([^)\s]+)/g)].map((m) => m[1]),
  ...[...text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]),
  ...[...text.matchAll(/(?:href|src)\s*=\s*(?:("|')([^"']*)\1|([^\s>"']+))/g)].map((m) => m[2] ?? m[3]),
]

const ASSET_IDS = (text) => [...text.matchAll(/user-attachments\/assets\/([0-9a-f-]+)/g)].map((m) => m[1])

// Measured at 9016902 with one exempt region (`npm-has-no-video`). The exempt caps sit exactly on
// what that region costs today — 1 line on the root side, 6 on the cli — because the exempt span is
// where drift hides, so growing it should have to be raised by hand in a diff somebody reads.
const MAX_EXEMPT_LINES = { root: 1, cli: 6 }

// Measured: 41 link targets in the whole cli README. A floor rather than the exact count, so
// adding a link is ordinary work — its job is to fail when the extractor matches nothing at all,
// which would make the assertion above vacuously true.
const MIN_CLI_LINK_TARGETS = 41

// The compared span measured 247 lines on both sides. This floor sits well below that on purpose:
// deleting a section from both READMEs is ordinary correct work and must not fail here. It exists to
// catch an extraction that silently emptied the comparison, not to pin the document's length.
const MIN_COMPARED_LINES = 200

/**
 * Split a README into the span that is compared and the regions marked exempt.
 *
 * A recognised marker that is unbalanced throws. There is no lenient branch, because the failure
 * being guarded against is the opposite one — a reading where a broken marker quietly widens what is
 * skipped. A line that is not marker-shaped is not treated as a marker; it stays in the comparison.
 */
export function split(text) {
  const compared = []
  const exempt = []
  let open = null

  text.split('\n').forEach((line, i) => {
    const at = `line ${i + 1}`
    const opened = OPEN.exec(line)

    if (opened) {
      if (open) throw new Error(`readme-sync: exempt region opened inside another at ${at}`)
      open = { reason: opened[1] ?? null, lines: [], at }
      return
    }
    if (CLOSE.test(line)) {
      if (!open) throw new Error(`readme-sync: exempt region closed without opening at ${at}`)
      exempt.push(open)
      open = null
      return
    }
    ;(open ? open.lines : compared).push(line)
  })

  if (open) throw new Error(`readme-sync: exempt region opened at ${open.at} is never closed`)
  return { compared, exempt }
}

const normalise = (lines) =>
  lines.map((l) => REWRITES.reduce((acc, prefix) => acc.split(prefix).join(''), l))

const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

// Parsed on demand, not at module scope. `split` throws on an unbalanced marker, and a throw during
// collection takes the whole file down — reported as "no tests", with the assertions below that
// prove the parser never running. Lazily, the same marker fails named tests instead.
let cache = null
const parsed = () => (cache ??= Object.fromEntries(PAIR.map(({ label, path }) => [label, split(read(path))])))

describe('a marker is recognised by its shape, and a recognised one must balance', () => {
  it('rejects an opening marker that is never closed', () => {
    expect(() => split('a\n<!-- readme-sync:exempt why -->\nb\n')).toThrow(/never closed/)
  })
  it('rejects a closing marker with nothing open', () => {
    expect(() => split('a\n<!-- /readme-sync:exempt -->\n')).toThrow(/without opening/)
  })
  it('rejects a region opened inside another', () => {
    expect(() => split('<!-- readme-sync:exempt a -->\n<!-- readme-sync:exempt b -->\n')).toThrow(/inside another/)
  })
  it('keeps an ordinary line out of the exempt span', () => {
    const { compared, exempt } = split('a\n<!-- readme-sync:exempt why -->\nb\n<!-- /readme-sync:exempt -->\nc\n')
    expect(compared).toEqual(['a', 'c', ''])
    expect(exempt).toEqual([expect.objectContaining({ reason: 'why', lines: ['b'] })])
  })
  it('does not treat a line that is merely marker-like as a marker', () => {
    // Indented, so it is content. It then fails the comparison rather than exempting anything —
    // loud in the safe direction.
    expect(split('  <!-- readme-sync:exempt why -->\n').exempt).toEqual([])
  })
  it('reads markers on a CRLF checkout', () => {
    const text = '<!-- readme-sync:exempt why -->\r\nb\r\n<!-- /readme-sync:exempt -->\r\n'
    expect(split(text).exempt).toEqual([expect.objectContaining({ reason: 'why' })])
  })
})

describe('the link extractor', () => {
  // Every form is one a contributor can write without knowing a guard is watching. A form that
  // slips past is invisible: the target count stays at its floor because the link was never
  // counted in the first place, so nothing reports the miss.
  const cases = [
    ['inline markdown', '[a](one.md)', 'one.md'],
    ['inline markdown with a title', '[a](two.md "t")', 'two.md'],
    ['a reference definition', '[a]: three.md', 'three.md'],
    ['a double-quoted attribute', '<img src="four.png" />', 'four.png'],
    ['a single-quoted attribute', "<img src='five.png' />", 'five.png'],
    ['whitespace around the equals sign', '<a href = "six.md">x</a>', 'six.md'],
    ['an unquoted value', '<a href=seven.md>x</a>', 'seven.md'],
  ]
  it.each(cases)('finds the target in %s', (_label, text, expected) => {
    expect(LINK_TARGETS(text)).toContain(expected)
  })
})

describe('the two READMEs', () => {
  it('declare the same exempt regions in the same order', () => {
    const reasons = (label) => parsed()[label].exempt.map((r) => r.reason)
    expect(reasons('cli')).toEqual(reasons('root'))
    expect(reasons('root')).toEqual(['npm-has-no-video'])
  })

  it('match outside the exempt regions once the npm URL prefixes are normalised', () => {
    expect(normalise(parsed().cli.compared)).toEqual(normalise(parsed().root.compared))
  })

  // The equality above is satisfied by two files that are wrong in the same way: copy a new
  // repo-relative link into both and forget to absolutise the cli one, and they still match while
  // the npm page carries a dead link. This is that property stated per link.
  // The whole file, not the compared span. Being exempt from the equality check does not make a
  // region exempt from npm being able to resolve it — and that region is where the npm-specific
  // markup is hand-written, so it is the likeliest place to type a repo-relative path.
  it('leave no repo-relative link anywhere in the copy npm renders', () => {
    const targets = LINK_TARGETS(read('packages/cli/README.md'))
    expect(targets.length, 'cli link targets found — zero means the extractor stopped matching')
      .toBeGreaterThanOrEqual(MIN_CLI_LINK_TARGETS)
    expect(targets.filter((t) => !/^(https?:|#)/.test(t)), 'cli link targets npm cannot resolve')
      .toEqual([])
  })

  it('are compared with rewrites that actually fire', () => {
    const cli = parsed().cli.compared.join('\n')
    const root = parsed().root.compared.join('\n')
    expect(REWRITES.map((prefix) => cli.split(prefix).length - 1).every((n) => n > 0)).toBe(true)
    // The root copy writes none of them, so a rewrite can only ever pull the cli side toward it.
    for (const prefix of REWRITES) expect(root).not.toContain(prefix)
  })

  // The one thing both exempt regions are supposed to share. Re-record the demo, update the root
  // asset id, and without this the cli copy keeps linking the old video with everything green.
  it('point their exempt regions at the same demo asset', () => {
    const ids = (label) => ASSET_IDS(parsed()[label].exempt.flatMap((r) => r.lines).join('\n'))
    expect(ids('root').length).toBeGreaterThan(0)
    expect(ids('cli')).toEqual(ids('root'))
  })

  it('are compared over a span the exempt regions have not eaten', () => {
    for (const { label } of PAIR) {
      const { compared, exempt } = parsed()[label]
      const exemptLines = exempt.reduce((n, r) => n + r.lines.length, 0)
      expect(exemptLines, `${label} exempt lines (measured ${MAX_EXEMPT_LINES[label]}; raise it here in the same diff if the region deliberately grew)`)
        .toBeLessThanOrEqual(MAX_EXEMPT_LINES[label])
      expect(compared.length, `${label} compared lines (floor ${MIN_COMPARED_LINES}; falling below it means the extraction dropped content, not that the README shrank)`)
        .toBeGreaterThanOrEqual(MIN_COMPARED_LINES)
    }
  })
})
