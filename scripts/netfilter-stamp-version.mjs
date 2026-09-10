#!/usr/bin/env node
/**
 * Print the `CFBundleVersion` `build.sh` should stamp into the **extension**, or nothing.
 *
 * Nothing means "mint a fresh one" — `build.sh` then falls back to the same epoch it gives the host,
 * so a build that changes the extension leaves both numbers equal, which is what every install in the
 * wild already looks like. The split only shows up on a build that changed nothing but `Host/`.
 *
 * **Split out of `build.sh` so it can be tested.** The script around it needs a Developer ID and
 * notarization and runs on one Mac; this half is a hash and a comparison, and it decides whether
 * every user of the next release performs a system-extension replace.
 *
 * Silent on **stdout** whenever in doubt: nothing printed means `build.sh` mints a fresh version, and
 * the cost is one replace nobody needed. The other direction — reusing a version for an extension
 * that changed — is a replace macOS skips silently, and no later build can undo it.
 *
 * **Not silent on stderr, and that is the difference between a mechanism and a mechanism that stopped
 * working.** A probe that cannot run answers exactly like a real change: a fresh version, every
 * build. Without a word about which happened, the whole thing can revert to pre-#724 behaviour and
 * the only symptom is replaces coming back — on a path no CI runs, since these probes are macOS-only.
 */
import path from 'node:path'
import { extVersionToStamp, SHIPPED_APP, EXT_PROFILE } from './lib/netfilter-artifact.mjs'
import { localProfileHash, localToolchain, shippedProfileName } from './lib/netfilter-local.mjs'

const repo = path.resolve(import.meta.dirname, '..')
/** stderr, never stdout: `build.sh` reads stdout as the version to stamp. */
const note = (why) => process.stderr.write(`netfilter-stamp-version: ${why}\n`)
try {
  // The two inputs no repo file can show: the provisioning profile this Mac would embed, and the
  // toolchain that would build it. Both are read here rather than in the library, because both are
  // macOS-only and the library is unit-tested on the CI's Linux.
  const name = shippedProfileName(path.join(repo, SHIPPED_APP, ...EXT_PROFILE))
  const profile = name === null ? null : localProfileHash(name)
  const toolchain = localToolchain()
  if (name === null) note('cannot read the profile name out of the shipped extension')
  else if (profile === null) note(`no local provisioning profile named ${JSON.stringify(name)}`)
  if (toolchain === null) note('cannot read the toolchain (xcodebuild / xcrun)')

  const v = extVersionToStamp(repo, { profile, toolchain })
  if (v) process.stdout.write(v)
  else if (profile !== null && toolchain !== null) note('the extension changed — a new version will be minted')
} catch (err) {
  process.stderr.write(`netfilter-stamp-version: ${err.message}\n`)
}
