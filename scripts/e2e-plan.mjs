#!/usr/bin/env node
// Writes this release's manual E2E plan to `.work/e2e/v<version>.md`, from the two files that
// already hold everything it needs: the fixed core pass in `.internal/MANUAL-E2E-CHECKLIST.md`, and
// the changelog section `changeset version` just promoted.
//
// **Why a generated file rather than a section to edit.** The checklist's own history: 70 items, and
// eight releases (v0.15.0 → v0.20.1) went by with it run zero times. Two causes, and neither was
// discipline — there was no unit smaller than "all of it", and the release-specific section asked to
// be *rewritten* before the run, so the first move was an essay. The deciding one is that skipping
// left no trace: a skipped pass and a passed pass looked identical. A file that is absent does not.
//
// Every failure here is loud. A script that writes half a plan and exits 0 reproduces exactly the
// failure it exists to end, so a missing checklist, an unpromoted version and a core section that
// came back nearly empty all stop with a reason.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogEntries, renderPlan, sectionItems } from './lib/e2e-plan.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKLIST = join(ROOT, '.internal/MANUAL-E2E-CHECKLIST.md')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')

// The core pass is ten items. A floor well under that catches a renamed heading or a reformatted
// list — both of which would otherwise produce a plan with a heading and nothing under it.
const CORE_FLOOR = 5

function die(message) {
  console.error(message)
  process.exit(1)
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const wanted = args.find((a) => !a.startsWith('-'))

// Derived, not typed. `/release` learned this the hard way on its own checks: a version written into
// a script is correct until the cycle it is not, and then every range silently matches nothing.
const version =
  wanted?.replace(/^v/, '') ??
  JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')).version

if (!existsSync(CHECKLIST)) {
  die(
    `No checklist at ${CHECKLIST}.\n\n` +
      '`.internal/` is gitignored, so a fresh clone does not have it — the plan is generated from it\n' +
      'and there is nothing to generate from. Nothing was written.',
  )
}

const checklist = readFileSync(CHECKLIST, 'utf8')
const prep = sectionItems(checklist, 0)
const core = sectionItems(checklist, 1)

if (core.length < CORE_FLOOR) {
  die(
    `The core pass came back with ${core.length} item(s), below the floor of ${CORE_FLOOR}.\n\n` +
      'Either §1 of the checklist was renamed or its items stopped looking like `- [ ] `.\n' +
      'Refusing to write a plan whose core is empty — that is the plan not existing, with a file.',
  )
}

// `prep` needs a floor of its own. `CORE_FLOOR` guards only §1, so renaming §0 produced a plan with a
// heading and nothing under it — and exited 0, which is the shape this file claims not to have.
if (prep.length === 0) {
  die(
    'The preparation section came back empty.\n\n' +
      'Either §0 of the checklist was renamed or its items stopped looking like `- [ ] `.\n' +
      'It holds the `tapflow doctor` step whose absence produced the defect the one real run found.',
  )
}

const entries = changelogEntries(readFileSync(CHANGELOG, 'utf8'), version)
if (entries === null) {
  die(
    `CHANGELOG.md has no section for ${version}.\n\n` +
      'Run this after `changeset version` and after promoting `[Unreleased]` to `[X.Y.Z] - DATE`.\n' +
      'Before that the release-specific half would be empty, which is the half that makes this plan\n' +
      'about this release.',
  )
}
// **A heading with nothing under it is not a release that changed nothing.** The renderer has a branch
// for it, which was the mistake: that state is reachable without any mutation — a promoted heading
// whose body has no `###` subsections, or subsections with no bullets — and it wrote a plan claiming
// this version is user-visibly empty, at exit 0.
if (entries.length === 0) {
  die(
    `CHANGELOG.md has a ${version} heading but nothing under it.\n\n` +
      'The release half of the plan would be empty. Check that the promoted section kept its\n' +
      '`### Added` / `### Fixed` / `### Security` subsections and their bullets.',
  )
}

const out = join(ROOT, '.work/e2e', `v${version}.md`)
if (existsSync(out) && !force) {
  die(
    `${out} already exists.\n\n` +
      'It may be a run in progress — overwriting it would discard the results filled in so far.\n' +
      'Pass --force to replace it.',
  )
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  renderPlan({
    version,
    date: new Date().toISOString().slice(0, 10),
    prep,
    core,
    entries,
  }),
)

const n = entries.reduce((a, e) => a + e.items.length, 0)
console.log(`${out}\n  core ${core.length} · prep ${prep.length} · v${version} 항목 ${n}`)
