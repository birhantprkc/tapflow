// The plan generator moves text rather than composing it, so every defect it can have is a parsing
// defect — an item silently truncated, a section leaking into the next, a version whose changelog
// section does not exist yet answered with an empty plan instead of a refusal. Each case below names
// the mutation that kills it.
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { changelogEntries, renderPlan, sectionItems } from '../lib/e2e-plan.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const CHECKLIST = `# 수동 E2E 체크리스트

## 0. 준비

- [ ] \`pnpm build\` — LAN(:4000)은 빌드된 \`public/\`을 서빙한다
- [ ] \`tapflow doctor\` — Android는 build-tools가 필수.
      해소: \`sdkmanager --sdk_root="$ANDROID_HOME" "build-tools;35.0.0"\`

---

## 1. 코어 패스 — 한 플랫폼 15분

설명 문단은 항목이 아니다.

- [ ] 디바이스 목록에 시뮬/에뮬이 뜬다
- [ ] 부팅 → 화면이 제대로 보인다
- [ ] 오디오가 들린다
- [ ] 클립보드 양방향
- [ ] 두 탭이 같은 세션을 열면 두 번째가 거부된다

열 개다.

---

## 2. 이번 릴리스가 건드린 것

- [ ] 여기 것이 §1로 새면 안 된다
`

describe('sectionItems — reads one section of the checklist', () => {
  // Mutation: drop the `^## ` stop and §2's item joins the core pass, so every release's plan
  // carries the previous release's items forever.
  it('stops at the next heading', () => {
    const core = sectionItems(CHECKLIST, 1)
    expect(core).toHaveLength(5)
    expect(core.join('\n')).not.toContain('§1로 새면 안 된다')
  })

  // Mutation: keep only the `- [ ] ` line and the doctor item loses the command that resolves it —
  // the checklist's single most operational line, and the fix for the defect its one real run found.
  it('keeps the indented lines that continue an item', () => {
    const prep = sectionItems(CHECKLIST, 0)
    expect(prep).toHaveLength(2)
    expect(prep[1]).toContain('sdkmanager --sdk_root')
  })

  // Mutation: return the whole file when the heading is absent. The caller's floor check would then
  // pass on a checklist that has no §1 at all.
  it('returns nothing for a section that is not there', () => {
    expect(sectionItems(CHECKLIST, 7)).toEqual([])
  })

  it('does not mistake prose for an item', () => {
    expect(sectionItems(CHECKLIST, 1).join('\n')).not.toContain('설명 문단은')
  })
})

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.21.0] - 2026-09-11

### Added

- **Docker is a documented way to run the relay.** The image has been on Docker Hub since 0.20.0
  and nothing in the guide said so.

### Fixed

- **android-agent**: Log unexpected scrcpy server process exits with their exit code. Expected
  exits log at debug level.

- No bold lead at all. This second sentence must not be carried into the item.

### Security

- \`js-yaml\` moved to 3.15.2.

## [0.20.1] - 2026-09-04

### Fixed

- Something from the previous release.
`

describe('changelogEntries — takes this release and no other', () => {
  // Mutation: drop the `^## ` bound and 0.20.1's entry lands in 0.21.0's plan, which is how a
  // scoped pass quietly turns back into the 70-item list.
  it('stops at the previous version', () => {
    const groups = changelogEntries(CHANGELOG, '0.21.0')
    expect(groups.flatMap((g) => g.items).join('\n')).not.toContain('previous release')
  })

  // Mutation: group everything under one heading. Security is the one section that is usually
  // dependency bumps with nothing to look at, and the plan tells the reader to strike it — it can
  // only do that if it is still a section.
  it('groups by changelog section', () => {
    expect(changelogEntries(CHANGELOG, '0.21.0').map((g) => g.section))
      .toEqual(['Added', 'Fixed', 'Security'])
  })

  // Mutation: `return []`. The script writes a plan whose release half is empty and exits 0 —
  // indistinguishable from a release that changed nothing, which is never true.
  it('answers null for a version the changelog has not promoted', () => {
    expect(changelogEntries(CHANGELOG, '0.22.0')).toBeNull()
    expect(changelogEntries(CHANGELOG, 'Unreleased')).not.toBeNull()
  })
})

describe('changelogEntries — the item text is something to check', () => {
  const items = (section) =>
    changelogEntries(CHANGELOG, '0.21.0').find((g) => g.section === section).items

  // Mutation: `return bold[1]`. This produced the item `android-agent` — a package name and no
  // thing to look at, the exact shape of line that gets ticked without being read. Caught by
  // running the generator on the real changelog rather than by reading it.
  it('appends the sentence when the bold run is a label', () => {
    expect(items('Fixed')[0]).toMatch(/^android-agent: Log unexpected scrcpy/)
  })

  // Mutation: always append the following sentence, and a title-shaped lead drags a paragraph
  // behind it.
  it('uses a bold title as the whole item', () => {
    expect(items('Added')).toEqual(['Docker is a documented way to run the relay.'])
  })

  // Mutation: take the whole bullet. A checklist line holding a paragraph is one nobody reads.
  it('takes one sentence from a bullet with no bold run', () => {
    expect(items('Fixed')[1]).toBe('No bold lead at all.')
  })
})

describe('renderPlan', () => {
  const plan = renderPlan({
    version: '0.21.0',
    date: '2026-09-11',
    prep: sectionItems(CHECKLIST, 0),
    core: sectionItems(CHECKLIST, 1),
    entries: changelogEntries(CHANGELOG, '0.21.0'),
  })

  // Mutation: render only the release half. The core pass is the half that catches what the diff
  // does not point at, which is what the one real run of this checklist actually found.
  it('carries the core pass verbatim', () => {
    expect(plan).toContain('- [ ] 클립보드 양방향')
    expect(plan).toContain('- [ ] `tapflow doctor`')
  })

  it('names the version it is for', () => {
    expect(plan).toContain('# 수동 E2E — v0.21.0')
  })

  // Mutation: drop the notice. Security items are then ticked one by one, each a dependency bump
  // with nothing on screen to see.
  it('tells the reader a Security section is usually nothing to run', () => {
    expect(plan).toMatch(/### Security[\s\S]*의존성 범프/)
  })
})

describe('the script refuses loudly', () => {
  // Mutation: exit 0 after printing. A generator that half-works and says nothing reproduces the
  // failure it exists to end — a pass that was never run, looking exactly like one that was.
  it('will not write a plan for a version the changelog has no section for', () => {
    let failed = false
    let stderr = ''
    try {
      execFileSync('node', [join(ROOT, 'scripts/e2e-plan.mjs'), '9.9.9'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      failed = true
      stderr = err.stderr ?? ''
    }
    expect(failed).toBe(true)
    expect(stderr).toContain('CHANGELOG.md has no section for 9.9.9')
  })
})
