// The symbols `doctor` looks for are the symbols the hook actually rebinds.
//
// **A copy exists and this is what makes it safe.** `wanted[]` lives in the injected library's source
// (`packages/ios-agent/src/network-hook.m`), which the CLI does not ship — and it cannot be recovered
// from the shipped dylib either: three of the four are resolved with `dlsym(RTLD_DEFAULT, name)`, so
// they are C string literals rather than import entries. Measured against the built artifact with
// `scripts/lib/macho.mjs`: only `_getaddrinfo` appears in its symbol table at all.
//
// So the CLI keeps its own list, and the drift that costs something is one direction: a symbol added
// to `wanted[]` and not to the check. The install is all-or-none, so the new symbol failing takes the
// whole feature down while `doctor` goes on reporting that everything it knows about is present —
// a check that is green precisely because it has not been told what to look for.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const HOOK = 'packages/ios-agent/src/network-hook.m'
const DOCTOR = 'packages/cli/src/lib/doctor.ts'

/**
 * Every table in the dylib that installs hooks. **Naming them is the load-bearing part.**
 *
 * There were two lists here once — `wanted[]`, and a check that read only `wanted[]` — and the second
 * reachability set landed in a table of its own, which is a legitimate design (the two sets are
 * all-or-none separately) and was invisible to this file. The guard went green over three symbols
 * `doctor` had never been told to look for: the exact shape the header calls "a check that is green
 * precisely because it has not been told what to look for", arriving through a new table rather than
 * a new entry.
 *
 * So a table added to `network-hook.m` and not added here fails the count assertion below rather than
 * passing silently — `TABLES` is compared against how many `] = {` install tables the file actually
 * declares.
 */
const TABLES = ['wanted[] = {', 'reach[] = {']

/**
 * The `name` field of every entry in those tables.
 *
 * **`[A-Za-z0-9_]`, not `[a-z_]`.** The first version could not see a symbol with a capital or a
 * digit — so `SCNetworkReachabilityGetFlags`, which is the other API an app reads to decide it is
 * offline and the obvious next entry, parsed as nothing at all. The mutation this file's header names
 * as the one that costs something passed green for exactly those names.
 */
function rebound() {
  const src = readFileSync(join(ROOT, HOOK), 'utf8')
  // Every install table is written as `static const struct { … } <name>[] = {`. Counting the
  // declarations independently of `TABLES` is what makes a new one visible here instead of ignored.
  const declared = [...src.matchAll(/\}\s*([A-Za-z_][A-Za-z0-9_]*)\[\] = \{/g)].map((m) => m[1])
  expect(declared.sort(), 'network-hook.m declares an install table this check has not been told about')
    .toEqual(TABLES.map((t) => t.replace('[] = {', '')).sort())

  const names = []
  for (const table of TABLES) {
    const start = src.indexOf(table)
    expect(start, `${table} is gone — this check no longer guards anything`).toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf('};', start))
    const found = [...block.matchAll(/\{"([A-Za-z0-9_]+)"/g)].map((m) => m[1])
    // **Counted independently of the names**, because a name the regex cannot read does not fail — it
    // vanishes, and both lists then agree on a stale subset. Every entry ends with the address of its
    // original, so that is the count to compare against.
    const entries = block.split('(void **)&').length - 1
    expect(found.length, `read ${found.length} symbol names from ${entries} entries in ${table} — one is written in a shape this parser cannot see`)
      .toBe(entries)
    names.push(...found)
  }
  return names.sort()
}

/** The list `doctor` reads the SDK stubs for. */
function checked() {
  const src = readFileSync(join(ROOT, DOCTOR), 'utf8')
  const m = src.match(/const HOOK_SYMBOLS = \[([^\]]*)\]/)
  expect(m, 'HOOK_SYMBOLS is gone from doctor').toBeTruthy()
  const names = [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1])
  // Same reason, the other side: a quoted entry the class cannot read would drop out silently.
  expect(names.length, "doctor's list has an entry this parser cannot read")
    .toBe(m[1].split(',').filter((x) => x.trim().length > 0).length)
  return names.sort()
}

describe('doctor checks the symbols the hook actually needs', () => {
  it('reads both lists, so neither side can be empty and pass', () => {
    // Anti-vacuity from the measured count: nine in each — four path hooks plus five reachability
    // hooks. Two regexes that matched nothing would satisfy the comparison below by finding two empty
    // lists equal. **Set from the count, not rounded down**, so adding a set without adding it to
    // `doctor` cannot slip under a stale floor.
    expect(rebound().length, 'the rebinding tables parsed as empty').toBeGreaterThanOrEqual(9)
    expect(checked().length, "doctor's list parsed as empty").toBeGreaterThanOrEqual(9)
  })

  it('looks for exactly what is rebound', () => {
    expect(
      checked(),
      'The symbols `doctor` checks and the symbols the injected library rebinds have drifted apart.\n'
      + '  `wanted[]` is all-or-none, so one entry this Xcode no longer exports takes the whole feature\n'
      + `  down — and a check that has not been told to look for it reports green while that happens.\n`
      + `  Both lists: ${HOOK} and ${DOCTOR}.`,
    ).toEqual(rebound())
  })

  it('names stubs that exist in an SDK layout', () => {
    // A floor rather than a fence — it cannot know what a future SDK ships — but it catches the
    // rename that would make every symbol read as missing and every install read as broken.
    const src = readFileSync(join(ROOT, DOCTOR), 'utf8')
    expect(src, 'the SDK stub list is gone').toMatch(/const SDK_STUBS = \[/)
    expect(src).toContain('usr/lib/libSystem.tbd')
    expect(src).toContain('Network.framework/Network.tbd')
    // Without this the reachability names resolve against stubs that never declared them, and every
    // one reads as missing — the check failing for a reason that has nothing to do with the SDK.
    expect(src).toContain('SystemConfiguration.framework/SystemConfiguration.tbd')
  })
})
