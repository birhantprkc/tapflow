import fs from 'node:fs'
import path from 'node:path'
import { hashFiles, walk } from './artifact-hash.mjs'

/**
 * What ties the committed network-filter `.app` to the sources it was built from.
 *
 * The extension is signed and notarized on a maintainer's Mac and committed as a binary, because
 * ad-hoc signing does not load and the signing key deliberately does not live in CI. That leaves one
 * failure this repo can actually catch: **someone edits the Swift and forgets to rebuild**, and a
 * release ships a binary that does not match its own sources.
 *
 * **Recording the source hash alone would not catch it.** The person who forgets the rebuild forgets
 * the hash too, both values stay consistent with each other, and the check passes — it would only
 * catch someone who updated the record deliberately, which is the person who did not forget. So the
 * record carries the artifact's hash as well, and `build.sh` writes both in the same step that
 * produces the artifact.
 *
 * What it does **not** claim, and the list is worth reading before trusting this:
 *
 * - that the committed binary was built from the committed sources — nothing here can say that;
 * - anything about **how it was signed**. A Developer-ID-signed, notarized bundle and an ad-hoc one
 *   satisfy this identically, and ad-hoc is the thing that does not load. Recording the signing
 *   authority would need `codesign`, which is macOS-only while this runs on the CI's Linux.
 *
 * It says the two trees were recorded together and that neither has changed since. `project.pbxproj`
 * is deliberately not an input: `xcodegen` rewrites it on every build with fresh identifiers, so
 * hashing it would report a change for every build and nothing else.
 */
export const NETFILTER_DIR = 'packages/ios-agent/ios-netfilter'
export const SHIPPED_APP = 'packages/ios-agent/bin/TapflowNetFilter.app'
export const RECORD = `${NETFILTER_DIR}/shipped.json`

/**
 * Everything whose change means the artifact should be rebuilt.
 *
 * `build.sh` and the entitlements are in here for a reason the first draft missed: they change what is
 * produced without touching a line of Swift — signing flags, the hardened-runtime entitlements, the
 * notarization step.
 */
const EXT_SOURCE_GLOBS = [['Extension'], ['Shared']]
const EXT_SOURCE_FILES = ['project.yml', 'build.sh']
const HOST_SOURCE_GLOBS = [['Host']]
const HOST_SOURCE_FILES = []

/**
 * **The two halves, and why the line falls where it does** (#724).
 *
 * `build.sh` stamps one version into both `Info.plist`s, so a rebuild that changed only `Host/`
 * still bumps the extension and macOS performs a replace — measured, three of the six filter
 * rebuilds so far. Splitting the version needs a way to ask "did the *extension* change", which is
 * what these two lists are for.
 *
 * **Everything that is not `Host/` counts as an extension input**, `project.yml` and `build.sh`
 * included. Both change what the extension binary is without touching a line of Swift — signing
 * flags, the hardened runtime, the entitlements — and an extension that changed without its version
 * changing is replaced **silently** by macOS, which is the failure `project.yml` warns about in
 * capitals. So the boundary is drawn to be wrong in the direction that costs an unnecessary replace
 * rather than a skipped one.
 *
 * What that boundary still misses is `Host/`'s own signing surface: the sysext is nested inside the
 * host app and validated against it, so a host entitlement change alters the context an unchanged
 * extension runs in. `Host/` cannot simply be added — `Host/Info.plist` carries the per-build stamp
 * — so the field-level line is a decision of its own, tracked separately.
 */
const CFBUNDLEVERSION = /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/

/**
 * Blank the build stamp before hashing a plist.
 *
 * **Without this the whole mechanism is inert, and silently so.** `build.sh` writes
 * `CFBundleVersion` into `Extension/Info.plist` on every run, so hashing that file raw asks whether
 * the extension changed by reading back the number the previous build wrote — always different,
 * always "changed", always a bump. Every one of the six rebuilds so far changed that file by exactly
 * one line, and that line was the version.
 *
 * It also removes an ordering hazard that would otherwise be load-bearing and unwritten:
 * `xcodegen generate` resets the value to `CURRENT_PROJECT_VERSION` before `build.sh` patches it, so
 * the answer would depend on which side of `generate` the hash was taken.
 */
function withoutBuildStamp(rel, bytes) {
  if (!rel.endsWith('Info.plist')) return bytes
  return Buffer.from(bytes.toString('utf8').replace(CFBUNDLEVERSION, '$1$2'), 'utf8')
}

/** Read `CFBundleVersion` out of a plist on disk, or null. Regex rather than `plutil`, because this
 *  runs on the CI's Linux where `plutil` does not exist — both plists are XML with exactly one such
 *  key. */
function versionIn(plistPath) {
  if (!fs.existsSync(plistPath)) return null
  const m = fs.readFileSync(plistPath, 'utf8').match(CFBUNDLEVERSION_VALUE)
  return m ? m[1] : null
}
const CFBUNDLEVERSION_VALUE = /<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/

/** Where the extension's own plist sits inside the shipped app. */
export const EXT_PLIST = [
  'Contents', 'Library', 'SystemExtensions',
  'dev.tapflow.netfilter.ext.systemextension', 'Contents', 'Info.plist',
]

/**
 * **A declared input that is not there is an error, not an empty set.**
 *
 * Both halves of this used to shrug: a missing directory returned nothing and a missing file was
 * skipped. Renaming `build.sh` — the file whose comment above says it is watched *because* it changes
 * the artifact without touching Swift — would have dropped it from the hash silently, and the
 * file-count floor cannot see it: one aggregate number stays comfortably above the floor while a
 * whole directory goes unwatched.
 */
export function collectSources(repo) {
  return [...collectExtSources(repo), ...collectHostSources(repo)].sort()
}

/** Inputs that decide the **extension** binary. */
export function collectExtSources(repo) {
  return collect(repo, EXT_SOURCE_GLOBS, EXT_SOURCE_FILES)
}

/** Inputs that decide only the **host app**. */
export function collectHostSources(repo) {
  return collect(repo, HOST_SOURCE_GLOBS, HOST_SOURCE_FILES)
}

function collect(repo, globs, names) {
  const base = path.join(repo, NETFILTER_DIR)
  const files = []
  for (const [dir] of globs) {
    const d = path.join(base, dir)
    if (!fs.existsSync(d)) throw new Error(`netfilter guard: declared source directory is missing: ${path.relative(repo, d)}`)
    const found = walk(d)
    if (found.length === 0) throw new Error(`netfilter guard: declared source directory is empty: ${path.relative(repo, d)}`)
    files.push(...found)
  }
  for (const f of names) {
    const p = path.join(base, f)
    if (!fs.existsSync(p)) throw new Error(`netfilter guard: declared source file is missing: ${path.relative(repo, p)}`)
    files.push(p)
  }
  return files.sort()
}

export function collectAppFiles(repo) {
  return walk(path.join(repo, SHIPPED_APP)).sort()
}

export function computeRecord(repo) {
  const base = path.join(repo, NETFILTER_DIR)
  const extSources = collectExtSources(repo)
  const hostSources = collectHostSources(repo)
  const appFiles = collectAppFiles(repo)
  return {
    extSources: hashFiles(base, extSources, withoutBuildStamp),
    hostSources: hashFiles(base, hostSources, withoutBuildStamp),
    sourceFileCount: extSources.length + hostSources.length,
    // **The artifact is hashed raw**, unlike the sources above. The stamp is part of what shipped,
    // and blanking it here would let a rebuild that changed nothing but the version look identical to
    // the one before it — which is the rebuild this record exists to notice.
    app: hashFiles(path.join(repo, SHIPPED_APP), appFiles),
    appFileCount: appFiles.length,
    hostBundleVersion: versionIn(path.join(repo, SHIPPED_APP, 'Contents', 'Info.plist')),
    extBundleVersion: versionIn(path.join(repo, SHIPPED_APP, ...EXT_PLIST)),
  }
}

/**
 * The version `build.sh` should stamp into the extension, or `null` to mint a fresh one.
 *
 * Reuse is only ever the version **the committed app already declares** — the artifact rather than
 * the record, because the record is derived from it and one of the two has to be the original.
 */
export function extVersionToStamp(repo) {
  const record = readRecord(repo)
  if (!record || typeof record.extSources !== 'string') return null
  const now = hashFiles(path.join(repo, NETFILTER_DIR), collectExtSources(repo), withoutBuildStamp)
  if (now !== record.extSources) return null
  const shipped = versionIn(path.join(repo, SHIPPED_APP, ...EXT_PLIST))
  return Number.isFinite(Number(shipped)) ? shipped : null
}

/**
 * Did the extension's version go backwards?
 *
 * **The one failure a single commit cannot show.** Reusing a recorded version means a bad merge or a
 * revert can hand the next build a *lower* number, and macOS then skips the replace silently and
 * permanently — every later extension fix stops reaching that Mac while `doctor` stays green. The
 * previous value lives only in git, so this is asked across commits.
 *
 * Anything unparseable answers `true`: a version nobody can compare is not one this may wave through.
 */
export function extVersionWentBackwards(previous, current) {
  if (previous === null || previous === undefined) return false
  const a = Number(previous)
  const b = Number(current)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  return b < a
}

export function readRecord(repo) {
  const p = path.join(repo, RECORD)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}
