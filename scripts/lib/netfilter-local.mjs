import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * What **this Mac** will put into the extension, as opposed to what the committed bundle has.
 *
 * **Separate from `netfilter-artifact.mjs` because these probes are macOS-only** and that module runs
 * on the CI's Linux. Keeping them apart is what lets the reuse rule be unit-tested there: the caller
 * gathers these facts and passes them in, so a test supplies fixtures instead of a machine.
 *
 * Everything here answers `null` rather than guessing. `extVersionToStamp` reads `null` as "cannot
 * judge" and mints a fresh version, which costs a replace nobody needed — the direction this whole
 * mechanism is built to fail in.
 */

/**
 * Where macOS keeps downloaded provisioning profiles. **Both places, and the second one is the point.**
 *
 * Xcode 16 moved downloads to `Developer/Xcode/UserData/…` and leaves whatever is already in the
 * legacy directory alone. On this Mac the new one exists and is empty while all five profiles sit in
 * the old one — which is exactly the arrangement that makes reading only one of them dangerous: a
 * renewed profile lands in the new directory, the superseded copy stays in the old, and a search that
 * sees only the old finds a match and reuses the version for an extension that changed.
 *
 * That failure is worse than the one this file exists to fix, because it arrives after a maintainer
 * has stopped reaching for `FORCE_EXT_BUMP=1`. Reading both can only add candidates, and an extra
 * candidate costs a replace nobody needed.
 */
export const PROFILE_DIRS = [
  path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
  path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles'),
]

/**
 * The XML plist inside a `.provisionprofile`.
 *
 * **Read out of the file rather than through `security cms -D`**, which is the obvious way and makes
 * this whole module macOS-only — so the tests that exercise it could only run on a maintainer's Mac,
 * and CI ran none of the code that decides whether a build reuses a version.
 *
 * A `.provisionprofile` is CMS-signed, and the plist is the *content* being signed: it sits in the
 * clear, ahead of the certificate blob. Measured on the committed profile — `<?xml` at byte 62,
 * `</plist>` at 8984. Taking the first pair is therefore taking the content rather than something
 * that happens to look like it further in.
 *
 * `latin1` so byte offsets survive: the surrounding DER is not valid UTF-8, and decoding it as UTF-8
 * would replace bytes and move everything after them.
 *
 * **What is given up is verification.** `security` checks the CMS signature and this does not. That
 * costs nothing here: the values read are a name and a date, used only to choose which local file to
 * hash, and the hash is over the raw bytes either way.
 */
function decode(file) {
  let raw
  try {
    raw = fs.readFileSync(file).toString('latin1')
  } catch {
    return null
  }
  const start = raw.indexOf('<?xml')
  const end = raw.indexOf('</plist>', start)
  return start < 0 || end < 0 ? null : raw.slice(start, end + '</plist>'.length)
}

const stringOf = (xml, key) => xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null
const dateOf = (xml, key) => xml.match(new RegExp(`<key>${key}</key>\\s*<date>([^<]*)</date>`))?.[1] ?? null

/**
 * The profile this Mac would embed for `name`, by content.
 *
 * **Newest by creation date wins, because that is what Xcode picks and because being wrong here is
 * safe.** Two profiles can carry the same name: this Mac has an `…Ext DevID` from 09:12 and another
 * from 10:17 that adds an application-groups entitlement, and the committed bundle holds the later
 * one. Choosing differently from Xcode produces a mismatch, which mints a fresh version — an extra
 * replace, not a skipped one.
 *
 * Renewal moves the creation date forward, so the renewed profile is the one compared, which is the
 * case this exists for.
 */
export function localProfileHash(name, dirs = PROFILE_DIRS) {
  const candidates = []
  for (const dir of dirs) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.provisionprofile')) continue
      const file = path.join(dir, entry)
      const xml = decode(file)
      if (!xml || stringOf(xml, 'Name') !== name) continue
      candidates.push({ file, createdAt: dateOf(xml, 'CreationDate') })
    }
  }
  const best = newestProfile(candidates)
  return best === null ? null : createHash('sha256').update(fs.readFileSync(best.file)).digest('hex')
}

/**
 * Which of several same-named profiles a build would use.
 *
 * **Split out because the rest of this module cannot run off a Mac, and this rule can.** It is the
 * part that makes renewal detection work — a renewed profile carries a later creation date — and
 * leaving it inside the IO left it tested by nothing, which mutation said out loud.
 *
 * A candidate with no readable date loses to one that has a date and beats nothing: a profile whose
 * creation time cannot be read is not evidence about which is newer, and treating it as the newest
 * would let an unreadable file silence a real renewal.
 */
export function newestProfile(candidates) {
  let best = null
  for (const c of candidates) {
    if (c.createdAt == null) {
      best ??= c
      continue
    }
    if (best === null || best.createdAt == null || c.createdAt > best.createdAt) best = c
  }
  return best
}

/**
 * The name the committed extension's own profile carries.
 *
 * Read from the artifact rather than parsed out of `project.yml`, which declares one specifier per
 * target and would need a YAML parser to tell them apart. The bundle says which one it actually got.
 */
export function shippedProfileName(profilePath) {
  const xml = decode(profilePath)
  return xml === null ? null : stringOf(xml, 'Name')
}

/**
 * `DTXcodeBuild/DTSDKBuild` as this Mac would stamp them.
 *
 * The pair the committed extension's `Info.plist` carries, readable **before** a build — which is
 * what makes comparing them possible without building first. Measured: `17F113/25F70` from these two
 * commands and from the committed bundle alike.
 */
export function localToolchain() {
  try {
    const xcode = execFileSync('/usr/bin/xcodebuild', ['-version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
    }).match(/^Build version (\S+)$/m)?.[1]
    const sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-build-version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
    }).trim()
    return xcode && sdk ? `${xcode}/${sdk}` : null
  } catch {
    return null
  }
}
