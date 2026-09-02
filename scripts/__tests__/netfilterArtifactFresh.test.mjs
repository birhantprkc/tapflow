import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  computeRecord, readRecord, collectSources, collectExtSources, collectAppFiles,
  extVersionWentBackwards, extVersionToStamp, RECORD,
} from '../lib/netfilter-artifact.mjs'

/**
 * The network-filter extension is the one artifact in this repo that a contributor cannot rebuild:
 * ad-hoc signing does not load (measured `code=4`), so it is signed and notarized on a maintainer's
 * Mac and committed. That makes one mistake possible and invisible — editing the Swift and shipping
 * the old binary — and this is what catches it.
 *
 * **Read the failure message before assuming your change is wrong.** If you edited the extension's
 * sources, this failing is correct and expected: the artifact has to be rebuilt and re-recorded by
 * someone who can sign it. Say so on the PR; it is a handoff, not a defect in your change.
 */
const REPO = path.resolve(import.meta.dirname, '../..')

// Measured floors. A glob that matches nothing hashes to a constant, and every assertion below then
// passes while checking nothing — the shape `contributing/test-and-guard-coverage.md` calls a guard
// that certifies its own absence.
const MIN_SOURCE_FILES = 8
const MIN_APP_FILES = 6

describe('the shipped network filter matches what it was recorded against', () => {
  it('has a record at all', () => {
    expect(
      readRecord(REPO),
      'packages/ios-agent/ios-netfilter/shipped.json is missing — run scripts/record-netfilter-artifact.mjs',
    ).not.toBeNull()
  })

  it('is a record this build of the guard understands', () => {
    // **Read this one first when the three below fail together.** The record gained separate hashes
    // and versions for the extension and the host (#724), and `build.sh` writes it. A record without
    // them is not corrupt — it is a record from before that change, and the remedy is the same one
    // the whole file exists to ask for: rebuild.
    expect(
      readRecord(REPO).extSources,
      'shipped.json predates the extension/host version split.\n'
      + '  A contributor cannot fix this: the app is Developer-ID signed and notarized on a\n'
      + '  maintainer\'s Mac. A maintainer runs ios-netfilter/build.sh, which rebuilds, installs\n'
      + '  into the package and rewrites this record in one step.',
    ).toBeTypeOf('string')
  })

  it('sees enough files to be checking anything', () => {
    expect(collectSources(REPO).length, 'the source glob matched almost nothing').toBeGreaterThanOrEqual(MIN_SOURCE_FILES)
    expect(collectAppFiles(REPO).length, 'the app bundle looks empty').toBeGreaterThanOrEqual(MIN_APP_FILES)
  })

  it('still matches the sources it was built from', () => {
    const now = computeRecord(REPO)
    const recorded = readRecord(REPO)
    expect(
      `${now.extSources}/${now.hostSources}`,
      'The extension sources changed since the shipped app was built.\n'
      + '  A contributor cannot fix this: the app is Developer-ID signed and notarized on a\n'
      + '  maintainer\'s Mac, because ad-hoc signing does not load. Say on the PR that the\n'
      + '  extension needs rebuilding, and a maintainer runs ios-netfilter/build.sh — which\n'
      + '  rebuilds, installs into the package, and rewrites this record in one step.',
    ).toBe(`${recorded.extSources}/${recorded.hostSources}`)
  })

  it('is the same app that was recorded', () => {
    // The half that makes the check work at all. Recording only the sources fails in a way correlated
    // with the mistake: whoever forgets to rebuild forgets to re-record, both values stay consistent,
    // and the guard passes.
    const now = computeRecord(REPO)
    expect(now.app, 'the committed app is not the one in the record — re-run build.sh').toBe(readRecord(REPO).app)
  })

  it('carries both build versions the app declares', () => {
    // `CFBundleVersion` is what activation compares. A rebuild that does not raise it is replaced
    // silently by macOS — the README marks that with a star — and the CLI's version check would then
    // compare two identical numbers across different binaries.
    //
    // **Both, because they are now allowed to differ.** The host's rises on every build; the
    // extension's rises only when the extension's own inputs changed, and it is the extension's that
    // decides whether macOS replaces anything.
    const now = computeRecord(REPO)
    const recorded = readRecord(REPO)
    expect(now.hostBundleVersion).toBe(recorded.hostBundleVersion)
    expect(now.hostBundleVersion, 'the app declares no build version').toBeTruthy()
    expect(now.extBundleVersion).toBe(recorded.extBundleVersion)
    expect(now.extBundleVersion, 'the system extension declares no build version').toBeTruthy()
  })

  it('never declares an extension newer than the app carrying it', () => {
    // They come out of one build, and the extension's is either that build's number or an older one
    // it kept. Newer means somebody edited a plist by hand.
    const { hostBundleVersion: host, extBundleVersion: ext } = computeRecord(REPO)
    expect(Number.isFinite(Number(host)), `host version is not a number: ${host}`).toBe(true)
    expect(Number.isFinite(Number(ext)), `extension version is not a number: ${ext}`).toBe(true)
    expect(Number(ext), 'the extension claims to be newer than the app it ships in').toBeLessThanOrEqual(Number(host))
  })
})

/**
 * **The failure a single commit cannot show.**
 *
 * The extension's version is reused rather than minted, so its previous value lives in git and
 * nowhere else. A bad merge or a revert can hand the next build a lower number, and macOS then skips
 * the replace **silently and permanently** — every later extension fix stops reaching that Mac while
 * `doctor` reports three green checks. Every assertion above is satisfied by such a commit, because
 * within it the record and the artifact agree perfectly.
 */
describe('the extension version only ever goes up', () => {
  // The comparison is tested whether or not the ref is reachable. A guard that can only run in CI is
  // one nobody sees fail until it matters.
  it('refuses a decrease, and anything it cannot compare', () => {
    expect(extVersionWentBackwards('100', '101')).toBe(false)
    expect(extVersionWentBackwards('100', '100')).toBe(false)
    expect(extVersionWentBackwards('101', '100'), 'a decrease was allowed through').toBe(true)
    expect(extVersionWentBackwards(null, '100'), 'no previous value is not a decrease').toBe(false)
    expect(extVersionWentBackwards('abc', '100'), 'an unparseable previous was waved through').toBe(true)
    expect(extVersionWentBackwards('100', ''), 'an unparseable current was waved through').toBe(true)
    // `Number('')` is 0, not NaN — the one input where a finite check reads the wrong way.
    expect(extVersionWentBackwards('100', ' ')).toBe(true)
  })

  const baseline = (() => {
    for (const ref of ['origin/main', 'main']) {
      try {
        const raw = execFileSync('git', ['show', `${ref}:${RECORD}`], {
          cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        })
        return JSON.parse(raw)
      } catch { /* ref not fetched, or the file did not exist there yet */ }
    }
    return null
  })()

  // Named so a skip is legible in the output rather than looking like a pass. CI checks out with
  // `fetch-depth: 0`, so this runs there; a shallow clone is the case that skips.
  it.skipIf(baseline === null)('is not lower than the one on main', () => {
    const now = computeRecord(REPO)
    expect(
      extVersionWentBackwards(baseline.extBundleVersion, now.extBundleVersion),
      `the extension version went from ${baseline.extBundleVersion} to ${now.extBundleVersion}.\n`
      + '  macOS compares these and skips the replace when the new one is not higher — silently,\n'
      + '  and for good. Rebuild rather than resolving shipped.json by hand.',
    ).toBe(false)
  })
})

describe('what build.sh stamps into the extension', () => {
  it('reuses nothing when the record predates the split', () => {
    // The first build after this change mints a fresh version, because `build.sh` is itself an
    // extension input and changing it is a real change. One replace, once — and #726 made a replace
    // survivable, which is why this could be done in this order.
    const record = readRecord(REPO)
    if (typeof record.extSources !== 'string') {
      expect(extVersionToStamp(REPO), 'a legacy record must not be reused as a version').toBeNull()
    }
  })

  it('reuses the shipped version when the extension inputs are unchanged', () => {
    // Not a claim about today's tree: it asserts the rule, using whatever the record says now.
    const record = readRecord(REPO)
    const now = computeRecord(REPO)
    const stamp = extVersionToStamp(REPO)
    if (record.extSources === now.extSources) {
      expect(stamp, 'an unchanged extension was going to be given a new version').toBe(record.extBundleVersion)
    } else {
      expect(stamp, 'a changed extension was going to keep its version').toBeNull()
    }
  })

  it('ignores the build stamp when deciding whether the extension changed', () => {
    // The whole mechanism rests on this. `build.sh` writes `CFBundleVersion` into
    // `Extension/Info.plist` on every run, so hashing it raw asks whether the extension changed by
    // reading back the number the last build wrote — always different, always a bump, and the split
    // would be inert with nothing failing to say so.
    const files = collectExtSources(REPO)
    const plists = files.filter((f) => f.endsWith('Info.plist'))
    expect(plists.length, 'the extension inputs no longer include a plist — this guard is checking nothing').toBeGreaterThan(0)
    const before = computeRecord(REPO).extSources
    const original = new Map(plists.map((f) => [f, fs.readFileSync(f, 'utf8')]))
    try {
      for (const [f, text] of original) {
        fs.writeFileSync(f, text.replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/, '$19999999999$2'))
      }
      expect(computeRecord(REPO).extSources, 'the build stamp leaks into the extension hash').toBe(before)
    } finally {
      for (const [f, text] of original) fs.writeFileSync(f, text)
    }
  })
})
