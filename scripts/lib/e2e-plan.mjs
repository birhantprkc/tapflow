// The parsing half of `scripts/e2e-plan.mjs`, split out so it can be tested without the two files
// it normally reads — one of which (`.internal/MANUAL-E2E-CHECKLIST.md`) is gitignored and absent
// from a fresh clone.
//
// **Nothing here composes a test.** It moves text that is already written: the fixed core pass from
// the checklist, and this release's user-visible changes from the changelog section `changeset
// version` just promoted. That is deliberate — the section this replaces asked its reader to *write*
// the per-release list before running it, and eight releases went by with the list never run. A step
// whose first move is an essay does not happen.

/** A `- [ ]` item plus the indented lines that continue it. */
function collectItems(lines) {
  const items = []
  let current = null
  for (const line of lines) {
    if (/^- \[[ x]\] /.test(line)) {
      if (current) items.push(current)
      current = line
    } else if (current && /^\s+\S/.test(line)) {
      current += '\n' + line
    } else if (current && line.trim() === '') {
      // A blank line ends nothing on its own — an item's continuation may be separated by one —
      // but a blank followed by prose does. Held until the next line decides.
      current += '\n'
    } else if (current) {
      items.push(current.replace(/\n+$/, ''))
      current = null
    }
  }
  if (current) items.push(current.replace(/\n+$/, ''))
  return items
}

/**
 * Items under a `## <n>.` heading of the checklist, up to the next `## ` heading.
 * Returns `[]` when the heading is absent — the caller decides whether that is fatal, because
 * "section missing" and "section empty" have the same shape here and only one of them is a typo.
 */
export function sectionItems(markdown, n) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^## ${n}\\.`).test(l))
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## /.test(l))
  return collectItems(end === -1 ? rest : rest.slice(0, end))
}

/**
 * The changelog body for one version, as `[{ section, items }]`.
 *
 * `items` are the top-level bullets with their prose cut to the leading bold run — a changelog entry
 * here is a paragraph, and a checklist line that carries the paragraph is a checklist nobody reads.
 * The full text stays one link away, which the rendered plan says.
 */
export function changelogEntries(markdown, version) {
  const lines = markdown.split('\n')
  const esc = version.replace(/\./g, '\\.')
  const start = lines.findIndex((l) => new RegExp(`^## \\[?${esc}\\]?`).test(l))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## /.test(l))
  const body = end === -1 ? rest : rest.slice(0, end)

  const out = []
  let section = null
  let buffer = []
  const flush = () => {
    if (section === null) return
    const items = buffer
      .join('\n')
      .split(/\n(?=- )/)
      .map((b) => b.trim())
      .filter((b) => b.startsWith('- '))
      .map(lead)
    if (items.length) out.push({ section, items })
  }
  for (const line of body) {
    const h = /^### (.+)$/.exec(line)
    if (h) {
      flush()
      section = h[1].trim()
      buffer = []
    } else if (section !== null) {
      buffer.push(line)
    }
  }
  flush()
  return out
}

/**
 * The bolded lead of a changelog bullet, or its first sentence when it has no bold run.
 *
 * **A bold run followed by a colon is a label, not the lead.** `- **android-agent**: Log unexpected
 * scrcpy server process exits…` produced the item `android-agent`, which names a package and no
 * thing to check — the exact shape of checklist line that gets ticked without being read. When the
 * bold is a label the sentence after it is appended.
 */
function lead(bullet) {
  const text = bullet.replace(/^- /, '').replace(/\s+/g, ' ').trim()
  const bold = /^\*\*(.+?)\*\*(:?)/.exec(text)
  if (bold && !bold[2]) return clamp(bold[1].replace(/\s+$/, ''))
  const rest = bold ? text.slice(bold[0].length).trim() : text
  const stop = rest.search(/\. /)
  const first = stop === -1 ? rest : rest.slice(0, stop + 1)
  return clamp(bold ? `${bold[1]}: ${first}` : first)
}

function clamp(s) {
  return s.length > 160 ? s.slice(0, 157).trimEnd() + '…' : s
}

/** The plan document. Pure, so the test reads what a run would write. */
export function renderPlan({ version, date, prep, core, entries }) {
  const lines = [
    `# 수동 E2E — v${version}`,
    '',
    '> `pnpm e2e:plan`이 만든 파일이다. 손으로 쓰지 않는다 — 코어는',
    '> `.internal/MANUAL-E2E-CHECKLIST.md` §1에서, 아래 §2는 루트 `CHANGELOG.md`의 이 버전 절에서 왔다.',
    '> **항목의 "어떻게"는 체크리스트에 있다.** 여기 있는 건 이번에 무엇을 볼지다.',
    '',
    '| | |',
    '|---|---|',
    `| 버전 | \`v${version}\` |`,
    `| 생성일 | ${date} |`,
    '| 실행일 | (기입) |',
    '| 플랫폼 | iOS ☐ / Android ☐ |',
    '',
    '---',
    '',
    '## 0. 준비',
    '',
    ...prep,
    '',
    '---',
    '',
    '## 1. 코어 패스 — 한 플랫폼 15분',
    '',
    '건드린 곳이 아니라 **안 건드렸는데 깨진 곳**을 보는 장치다. v0.14.0 실행이 잡은 셋 중 가장 큰 것',
    '(apk `bundleId` null → 남의 앱에 편입)은 근본이 맥에 `aapt`가 없던 것이라, 어떤 diff도 가리킬 수',
    '없었다. 그래서 이 열 개는 릴리스가 무엇을 건드렸든 고정이다.',
    '',
    ...core,
    '',
    '---',
    '',
    `## 2. v${version}이 건드린 것`,
    '',
  ]

  if (!entries.length) {
    lines.push('(이 버전의 CHANGELOG 절에 사용자가 겪는 변경이 없다.)', '')
  }
  for (const { section, items } of entries) {
    lines.push(`### ${section}`, '')
    if (/security/i.test(section)) {
      lines.push(
        '> Security 절은 대개 의존성 범프라 수동으로 볼 것이 없다. 사용자가 겪는 동작이 달라진',
        '> 항목만 남기고 나머지는 지운다.',
        '',
      )
    }
    for (const item of items) lines.push(`- [ ] ${item}`)
    lines.push('')
  }

  lines.push(
    '> 전문은 루트 `CHANGELOG.md`의 해당 절에 있다. 여기 한 줄로는 무엇을 볼지까지만 말한다.',
    '',
    '---',
    '',
    '## 3. 결과',
    '',
    '- 통과: `- [ ]` → `- [x]`',
    '- 실패: 항목 옆에 증상을 적고 **이슈로 등록한다**. 재현이 안 되면 체크리스트 §7에 증상만 남긴다',
    '- 이 파일의 결과를 **릴리스 PR 본문에 붙인다** — 머지를 누르는 순간에 안 돌렸다는 것이 보여야 한다',
    '',
  )
  return lines.join('\n')
}
