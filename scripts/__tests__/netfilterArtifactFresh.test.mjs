import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { newestProfile } from '../lib/netfilter-local.mjs'
import { execFileSync } from 'node:child_process'
import {
  computeRecord, readRecord, collectSources, collectExtSources, collectHostSources, collectAppFiles,
  extVersionWentBackwards, extVersionToStamp, RECORD, SHIPPED_APP, EXT_PLIST, EXT_PROFILE,
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
// **Per half, because the combined floor cannot see a migration between them.** Three files could
// move from the extension's side to the host's and the total would not move — and from then on those
// files would stop bumping the extension's version, permanently and quietly.
const MIN_EXT_SOURCE_FILES = 6
const MIN_HOST_SOURCE_FILES = 2

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
    expect(collectExtSources(REPO).length, 'the extension half matched almost nothing').toBeGreaterThanOrEqual(MIN_EXT_SOURCE_FILES)
    expect(collectHostSources(REPO).length, 'the host half matched almost nothing').toBeGreaterThanOrEqual(MIN_HOST_SOURCE_FILES)
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
    // **`Number('')` and `Number(' ')` are `0`, not `NaN`** — finite, so a `Number.isFinite` check
    // accepts them while rejecting `'abc'`, which is what makes the hole look like a working guard.
    // As a previous value a blank becomes zero, and nothing is lower than zero.
    expect(extVersionWentBackwards('100', ' ')).toBe(true)
    expect(extVersionWentBackwards('', '100'), 'a blank previous was read as zero').toBe(true)
    expect(extVersionWentBackwards(' ', '100'), 'a whitespace previous was read as zero').toBe(true)
    // Absent is not blank: the commit that introduces the field has no previous value, and that is
    // not a regression.
    expect(extVersionWentBackwards(undefined, '100')).toBe(false)
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
  /** What a build machine carrying exactly what the committed bundle shipped would report. */
  const sameMachine = () => ({ profile: computeRecord(REPO).extProfile, toolchain: computeRecord(REPO).extToolchain })

  it('reuses the shipped version when the extension inputs are unchanged', () => {
    expect(computeRecord(REPO).extSources, 'the tree and the record disagree — rebuild first')
      .toBe(readRecord(REPO).extSources)
    expect(extVersionToStamp(REPO, sameMachine()), 'an unchanged extension was going to be given a new version')
      .toBe(readRecord(REPO).extBundleVersion)
  })

  // ── the two inputs that are not repo files (#728) ───────────────────────────────────────────
  //
  // Both change the shipped extension with nothing under `ios-netfilter/` moving. After #724 that is
  // no longer a harmless blind spot: a version reused for an extension that changed is a replace
  // macOS skips **silently**, and every check stays green.

  it('refuses to reuse when the provisioning profile changed', () => {
    // Renewal is annual, and the profile is the extension's only sealed resource — macOS validates
    // against it. The renewed one carries a later creation date, so it is the one a build embeds.
    expect(extVersionToStamp(REPO, { ...sameMachine(), profile: 'a'.repeat(64) }),
      'a renewed profile was going to ship under the old version').toBeNull()
  })

  it('refuses to reuse when the toolchain changed', () => {
    expect(extVersionToStamp(REPO, { ...sameMachine(), toolchain: '99Z999/99Z999' }),
      'a different Xcode was going to ship under the old version').toBeNull()
  })

  it('refuses to reuse when it cannot see the machine at all', () => {
    // **The standing rule of this module**: what it cannot judge gets a fresh version. A probe that
    // fails — no profile of that name, `xcodebuild` missing — must not read as "nothing changed".
    expect(extVersionToStamp(REPO, undefined), 'no machine facts was read as unchanged').toBeNull()
    expect(extVersionToStamp(REPO, { profile: null, toolchain: null })).toBeNull()
    expect(extVersionToStamp(REPO, { ...sameMachine(), profile: null })).toBeNull()
    expect(extVersionToStamp(REPO, { ...sameMachine(), toolchain: null })).toBeNull()
  })

  it('still reuses when only Host/ moved, which is the point of all this', () => {
    // The guard against over-correcting. Adding inputs is easy to do until nothing is ever reused,
    // and then #724 bought nothing.
    const victim = collectHostSources(REPO).find((f) => f.endsWith('.swift'))
    expect(victim, 'no Swift file in the host half — this test is checking nothing').toBeTruthy()
    const original = fs.readFileSync(victim, 'utf8')
    try {
      fs.writeFileSync(victim, `${original}\n// probe\n`)
      expect(extVersionToStamp(REPO, sameMachine()), 'a host-only change stopped reusing the version')
        .toBe(readRecord(REPO).extBundleVersion)
    } finally {
      fs.writeFileSync(victim, original)
    }
  })

  it('records the profile and toolchain the committed bundle actually carries', () => {
    // The Linux half. Both live on the maintainer's Mac, but the *shipped* copies are in the bundle,
    // which is what lets this be checked at all — and what keeps the record machine-independent.
    const now = computeRecord(REPO)
    const recorded = readRecord(REPO)
    expect(now.extProfile).toBe(recorded.extProfile)
    expect(now.extProfile, 'the extension ships no provisioning profile').toBeTruthy()
    expect(now.extToolchain).toBe(recorded.extToolchain)
    expect(now.extToolchain, 'the extension declares no toolchain').toMatch(/^\S+\/\S+$/)
    // Read straight off the bundle, so a record edited by hand cannot agree with itself.
    expect(fs.existsSync(path.join(REPO, SHIPPED_APP, ...EXT_PROFILE))).toBe(true)
  })

  it('picks the newest of several profiles carrying the same name', () => {
    // Renewal does not replace the old file — this Mac holds two `…Ext DevID` profiles from the same
    // morning, one of which adds an application-groups entitlement, and the committed bundle carries
    // the later one. Picking either would look right on a machine with one profile; picking the older
    // after a renewal is a version reused for an extension that changed, which macOS skips silently.
    expect(newestProfile([
      { file: 'old', createdAt: '2026-08-22T09:12:46Z' },
      { file: 'new', createdAt: '2026-08-22T10:17:20Z' },
    ])?.file).toBe('new')
    // Order must not decide it.
    expect(newestProfile([
      { file: 'new', createdAt: '2026-08-22T10:17:20Z' },
      { file: 'old', createdAt: '2026-08-22T09:12:46Z' },
    ])?.file).toBe('new')
    expect(newestProfile([])).toBeNull()
    // A date nobody can read is not evidence of being newest — it must not silence a real renewal.
    // **Both orders**, because only one of them tells the two implementations apart: reading the
    // undated one first, a rule that simply overwrites still lands on the dated one by accident.
    expect(newestProfile([
      { file: 'unreadable', createdAt: null },
      { file: 'dated', createdAt: '2020-01-01T00:00:00Z' },
    ])?.file).toBe('dated')
    expect(newestProfile([
      { file: 'dated', createdAt: '2020-01-01T00:00:00Z' },
      { file: 'unreadable', createdAt: null },
    ])?.file, 'an unreadable date displaced a real one').toBe('dated')
    // …but it is still better than nothing when it is all there is.
    expect(newestProfile([{ file: 'unreadable', createdAt: null }])?.file).toBe('unreadable')
  })

  it('leaves BuildMachineOSBuild out of the toolchain', () => {
    // **Deliberate, and the reason this is a chosen pair rather than "the build stamps".** It sits in
    // the same plist and moves on every macOS point update, so including it would bump the extension
    // for a software update that changed nothing about the binary — the cost #724 removed, with a
    // different trigger.
    const plist = fs.readFileSync(path.join(REPO, SHIPPED_APP, ...EXT_PLIST), 'utf8')
    const os = plist.match(/<key>BuildMachineOSBuild<\/key>\s*<string>([^<]*)<\/string>/)?.[1]
    expect(os, 'the plist no longer carries it — this guard is checking nothing').toBeTruthy()
    expect(computeRecord(REPO).extToolchain, 'the build machine OS leaked into the toolchain').not.toContain(os)
  })

  it('refuses to reuse when an extension source changed', () => {
    // **Driven rather than waited for.** Both halves of this rule used to sit behind an `if` on a
    // condition the committed tree does not satisfy, so only the reuse branch ever ran — the half
    // that prevents a silent skip was executed by nothing, in a test named after it.
    const victim = collectExtSources(REPO).find((f) => f.endsWith('.swift'))
    expect(victim, 'no Swift file in the extension half — this test is checking nothing').toBeTruthy()
    const original = fs.readFileSync(victim, 'utf8')
    try {
      fs.writeFileSync(victim, `${original}\n// probe\n`)
      expect(extVersionToStamp(REPO, sameMachine()), 'a changed extension was going to keep its version').toBeNull()
    } finally {
      fs.writeFileSync(victim, original)
    }
  })

  it('refuses to reuse a blank version', () => {
    // A blank one reaches all the way to the plist: `' '` is truthy, so it survives the stamp
    // helper's `if (v)` and `build.sh`'s `[ -n ... ]` and gets stamped as the version macOS compares.
    //
    // **The record has to be moved with the app, or this passes for the wrong reason.** Editing the
    // shipped bundle changes its hash, and the record-match guard above then returns `null` before
    // the version is ever read — so the assertion held while the check it names was unreachable.
    // Caught by mutation: removing that check left this test green.
    const plist = path.join(REPO, SHIPPED_APP, ...EXT_PLIST)
    const recordPath = path.join(REPO, RECORD)
    const originalPlist = fs.readFileSync(plist, 'utf8')
    const originalRecord = fs.readFileSync(recordPath, 'utf8')
    try {
      for (const blank of ['', ' ']) {
        fs.writeFileSync(plist, originalPlist.replace(
          /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${blank}$2`,
        ))
        fs.writeFileSync(recordPath, JSON.stringify(
          { ...JSON.parse(originalRecord), app: computeRecord(REPO).app }, null, 2,
        ))
        expect(extVersionToStamp(REPO, sameMachine()), `a blank version (${JSON.stringify(blank)}) was going to be stamped`).toBeNull()
      }
    } finally {
      fs.writeFileSync(plist, originalPlist)
      fs.writeFileSync(recordPath, originalRecord)
    }
  })

  it('refuses to reuse when the record and the shipped app describe different builds', () => {
    // The decision comes from the record and the version comes from the app, so a tree holding one
    // from each — the ordinary result of resolving a binary conflict — would stamp a number belonging
    // to neither, and the record written afterwards would be perfectly self-consistent.
    const record = readRecord(REPO)
    const original = fs.readFileSync(path.join(REPO, RECORD), 'utf8')
    try {
      fs.writeFileSync(path.join(REPO, RECORD), JSON.stringify({ ...record, app: 'deadbeef' }, null, 2))
      expect(extVersionToStamp(REPO, sameMachine()), 'it reused a version from an app the record does not describe').toBeNull()
    } finally {
      fs.writeFileSync(path.join(REPO, RECORD), original)
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

      // **And the rest of the plist still counts**, which is the direction the assertion above cannot
      // reach. Widening the normalizer until it blanked the whole file would satisfy it and satisfy
      // the record comparison too, because both sides normalize identically — while
      // `NEProviderClasses` and the mach service name silently left the extension's identity.
      for (const [f, text] of original) {
        fs.writeFileSync(f, text.replace('<key>CFBundleVersion</key>', '<key>TapflowProbeKey</key>'))
      }
      expect(computeRecord(REPO).extSources, 'the normalizer blanks more of the plist than the stamp').not.toBe(before)
    } finally {
      for (const [f, text] of original) fs.writeFileSync(f, text)
    }
  })
})
