#!/usr/bin/env node
// Writes the record that ties the committed injected library to its sources.
// `build-nethook.sh` runs this as its last step, so the binary and the record are produced together —
// which is the only arrangement where forgetting one cannot leave the other looking right.
import fs from 'node:fs'
import path from 'node:path'
import { computeRecord, readRecord, RECORD, SHIPPED_DYLIB } from './lib/nethook-artifact.mjs'

const repo = path.resolve(import.meta.dirname, '..')
const record = computeRecord(repo)
if (record.dylibBytes === 0) {
  console.error(`No dylib at ${SHIPPED_DYLIB} — build it before recording.`)
  process.exit(1)
}

// **Refuse to certify a stale binary against new sources.** This script needs nothing but node, so
// the cheapest way past a red guard is to run it — which rewrites both hashes and produces a record
// that is perfectly consistent with itself and wrong. If the sources moved and the binary did not,
// the binary was not rebuilt, and saying so here is the difference between a guard and a formality.
//
// **It catches that sequence and not the general case, which is worth stating plainly.** Sources
// unchanged with a *different* binary is a legitimate rebuild — clang stamps a fresh UUID every time
// — and a swapped-in one, and nothing here can tell them apart. A reviewer walked straight through
// with `main`'s pre-#653 dylib, and the check that stops it is not this one: it is
// `nethookVerdictAtomic` reading what the binary actually imports.
// **`--after-build` is how the build script says a build just happened**, and without it the refusal
// below has a false positive that would have taught people to edit the record by hand — the one
// thing it exists to prevent. A comment-only edit to `network-hook.m` changes the source hash and
// produces a **byte-identical** binary (clang derives `LC_UUID` from the content, so nothing varies),
// which is indistinguishable from having skipped the rebuild if all you compare is hashes. Measured
// while writing this file: the guard went red on a comment and there was no way forward through it.
const afterBuild = process.argv.includes('--after-build')

const previous = readRecord(repo)
if (!afterBuild && previous && previous.sources !== record.sources && previous.dylib === record.dylib) {
  console.error(
    'The hook sources changed but the dylib did not — it has not been rebuilt.\n'
    + '  Run packages/ios-agent/build-nethook.sh, which rebuilds and records in one step.\n'
    + '  (Recording on its own here would certify the old binary against the new sources. If you did\n'
    + '   rebuild and the output really is identical — a comment-only edit does that — let the build\n'
    + '   script record it; it passes --after-build.)',
  )
  process.exit(1)
}
fs.writeFileSync(path.join(repo, RECORD), `${JSON.stringify(record, null, 2)}\n`)
console.log(`recorded ${RECORD}: ${record.sourceFileCount} sources, ${record.dylibBytes} bytes`)
