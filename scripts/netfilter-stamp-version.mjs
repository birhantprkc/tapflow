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
 * Silent on failure, by design: any doubt prints nothing, `build.sh` mints a fresh version, and the
 * cost is one replace nobody needed. The other direction — reusing a version for an extension that
 * changed — is a replace macOS skips **silently**, and no later build can undo it.
 */
import path from 'node:path'
import { extVersionToStamp, SHIPPED_APP, EXT_PROFILE } from './lib/netfilter-artifact.mjs'
import { localProfileHash, localToolchain, shippedProfileName } from './lib/netfilter-local.mjs'

const repo = path.resolve(import.meta.dirname, '..')
try {
  // The two inputs no repo file can show: the provisioning profile this Mac would embed, and the
  // toolchain that would build it. Both are read here rather than in the library, because both are
  // macOS-only and the library is unit-tested on the CI's Linux.
  const name = shippedProfileName(path.join(repo, SHIPPED_APP, ...EXT_PROFILE))
  const v = extVersionToStamp(repo, {
    profile: name === null ? null : localProfileHash(name),
    toolchain: localToolchain(),
  })
  if (v) process.stdout.write(v)
} catch (err) {
  process.stderr.write(`netfilter-stamp-version: ${err.message}\n`)
}
