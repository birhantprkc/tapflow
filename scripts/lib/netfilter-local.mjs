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

/** Where macOS keeps downloaded provisioning profiles. Not `~/Library/Developer/Xcode/UserData/…`,
 *  which is empty on this Mac — measured. */
const PROFILE_DIR = path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles')

function decode(file) {
  try {
    // A `.provisionprofile` is CMS-signed; `security cms -D` unwraps it to an XML plist.
    return execFileSync('/usr/bin/security', ['cms', '-D', '-i', file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    })
  } catch {
    return null
  }
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
export function localProfileHash(name) {
  let entries
  try {
    entries = fs.readdirSync(PROFILE_DIR)
  } catch {
    return null
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.endsWith('.provisionprofile')) continue
    const file = path.join(PROFILE_DIR, entry)
    const xml = decode(file)
    if (!xml || stringOf(xml, 'Name') !== name) continue
    candidates.push({ file, createdAt: dateOf(xml, 'CreationDate') })
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
