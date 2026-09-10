// The injected library's verdict file is written to a temp path and renamed onto the target, so a
// reader never sees a torn one (#653). Two things can undo that and they fail differently:
//
//  1. **The source goes back to writing in place.** Caught by reading `tf_write_verdict`.
//  2. **The source is right and the shipped binary is the old one.** `nethookArtifactFresh` is the
//     general guard for that and is the one to read first. This check overlaps it and is kept for
//     the case it cannot see: that guard trusts `nethook-shipped.json`, and a record can be rewritten
//     by anyone who runs the recorder. What the dylib imports cannot.
//
// **The binary check reads the undefined-symbol table, and the first draft did not.** It searched the
// whole file for the bytes `_rename` and its header claimed that was structural. A reviewer disproved
// it in one compile: a dylib with zero `rename` imports, a `const char *note = "atomic_rename"` and a
// plain `fopen(path, "w")` — the very defect #653 removes — carries those bytes in `__cstring`, so the
// search passed on a binary doing exactly the wrong thing. Measured on three binaries: the shipped one
// imports `_rename`, `main`'s pre-#653 one does not, and the purpose-built fake has the bytes without
// the import. Only the symbol table separates the second from the third.
//
// That was this file breaking the rule it cites. `contributing/test-and-guard-coverage.md` §1 says a
// check must execute the lesson its own header cites, and §3 says a spelling assertion is a floor
// rather than a fence — and the draft quoted §3 while being one.
//
// The source checks below are still spelling assertions and still floors. Their structural twin is
// the symbol table, not their own wording.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { undefinedSymbols } from '../lib/macho.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const DYLIB = join(ROOT, 'packages', 'ios-agent', 'bin', 'libtapflow-nethook.dylib')
const SOURCE = join(ROOT, 'packages', 'ios-agent', 'src', 'network-hook.m')

/** `tf_write_verdict`'s body, from its opening brace to the closing brace in column 1. */
function writeVerdictBody() {
  const src = readFileSync(SOURCE, 'utf8')
  const start = src.indexOf('static void tf_write_verdict(')
  expect(start, 'tf_write_verdict is gone — this check no longer guards anything').toBeGreaterThan(-1)
  const end = src.indexOf('\n}\n', start)
  expect(end, 'tf_write_verdict has no closing brace in column 1').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('the shipped dylib writes its verdict atomically', () => {
  it('imports rename, as a symbol-table entry rather than bytes somewhere in the file', () => {
    const imports = undefinedSymbols(readFileSync(DYLIB))
    // Anti-vacuity floor from the measured count (92). A parser that silently returned nothing would
    // make every assertion here pass while reading no symbols at all.
    expect(imports.length, 'the symbol table came back empty — the parser, not the binary').toBeGreaterThan(50)
    // `toContain` on an array is an exact entry, never a substring: a local helper named
    // `tf_atomic_rename` has `_rename` inside it and imports nothing.
    expect(
      imports,
      'the committed dylib does not import rename — the source was changed without rebuilding it, '
        + 'or the write went back in place. Run packages/ios-agent/build-nethook.sh.',
    ).toContain('_rename')
    // The other two the write path needs. Losing one means an error path was dropped, which is how a
    // failed write gets renamed over a good file.
    expect(imports).toContain('_unlink')
    expect(imports).toContain('_fclose')
  })

  it('opens a temp path and reaches the target only through rename', () => {
    const body = writeVerdictBody()
    // The claim is about which path `fopen` is given, not that `fopen` is absent — writing still
    // uses it, one file over.
    expect(body).toMatch(/fopen\(tmp,/)
    expect(body, 'fopen truncates the target in place, which is the defect').not.toMatch(/fopen\(path,/)
    expect(body).toMatch(/rename\(tmp, path\)/)
  })

  it('removes the temp file on every path that does not rename it', () => {
    // Otherwise a failing app leaves one `.tmp` per launch in the simulator's /tmp, and the failure
    // that produced them is silent by construction.
    const body = writeVerdictBody()
    const renames = (body.match(/rename\(/g) ?? []).length
    const unlinks = (body.match(/unlink\(/g) ?? []).length
    expect(renames).toBe(1)
    expect(unlinks, 'a write that fails after creating the temp file leaves it behind').toBe(2)
  })

  it('refuses a temp name that truncated onto the target', () => {
    // `snprintf` truncates silently. At a udid long enough to fill `path`, the `.<pid>.tmp` suffix is
    // cut away entirely, `tmp` equals `path`, and `fopen(tmp, "w")` is the in-place truncation this
    // function exists to remove — with `rename` then succeeding as a no-op, so nothing reports.
    expect(writeVerdictBody(), 'the snprintf into tmp is unchecked').toMatch(/n >= \(int\)sizeof\(tmp\)/)
  })
})
