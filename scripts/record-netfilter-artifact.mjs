#!/usr/bin/env node
// Writes the record that ties the committed network-filter app to its sources.
// `build.sh` runs this as its last step, so the artifact and the record are produced together —
// which is the only arrangement where forgetting one cannot leave the other looking right.
import fs from 'node:fs'
import path from 'node:path'
import { computeRecord, readRecord, RECORD } from './lib/netfilter-artifact.mjs'

const repo = path.resolve(import.meta.dirname, '..')
const record = computeRecord(repo)
if (record.appFileCount === 0) {
  console.error(`No app at packages/ios-agent/bin/TapflowNetFilter.app — build it before recording.`)
  process.exit(1)
}

// **Refuse to certify a stale binary against new sources.** This script needs nothing but node, so
// the cheapest way past a red guard is to run it — which rewrites both hashes and produces a record
// that is perfectly consistent with itself and wrong. If the sources moved and the app did not, the
// app was not rebuilt, and saying so here is the difference between a guard and a formality.
const previous = readRecord(repo)
// Both halves, and a record written before the split counts as different — which is right: the split
// arrived with a `build.sh` change, and that is a source change like any other.
const sourcesMoved = previous
  && (previous.extSources !== record.extSources || previous.hostSources !== record.hostSources)
if (previous && sourcesMoved && previous.app === record.app) {
  console.error(
    'The extension sources changed but the app did not — it has not been rebuilt.\n'
    + '  Run ios-netfilter/build.sh, which rebuilds, installs into the package and records in one step.\n'
    + '  (Recording on its own here would certify the old binary against the new sources.)',
  )
  process.exit(1)
}
fs.writeFileSync(path.join(repo, RECORD), `${JSON.stringify(record, null, 2)}\n`)
console.log(
  `recorded ${RECORD}: ${record.sourceFileCount} sources, ${record.appFileCount} app files,`
  + ` host ${record.hostBundleVersion}, extension ${record.extBundleVersion}`,
)
