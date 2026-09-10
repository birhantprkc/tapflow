// The Stop gate that asks for an ai-tells pass when the session edited prose under `docs/`.
//
// **It had no test, and it was seeing 6 of 34 docs edits.** The transcript matcher required
// `file_path` to be the first key of the tool input, with a comment saying it is. That is true of
// `Write` and false of `Edit`, which serialises `{"replace_all": false, "file_path": …}` — measured
// across this project's transcripts, 1102 `Edit` records and not one of them adjacent. Editing an
// existing document is what `Edit` is for, so the gate was blind to the common case while reporting
// nothing wrong.
//
// Widening the regex fixed that case and kept the shape of the bug, which review then found: still
// blind to `MultiEdit` with `edits` before `file_path`, counting `.mdx` for an unanchored `\.md`, and
// missing the record entirely if the runtime emitted spaced JSON. The hook parses with `jq` now, so
// none of those is a question about key order any more.
//
// **The `input` shapes below are the real ones** — verified against the corpus, `Edit` writes
// `{"replace_all": …, "file_path": …}` and `Write` writes `{"file_path": …}` — but the envelope is
// not: a real record also carries `id`, `parentUuid`, `message.model` and more. They are omitted
// because nothing here reads them, and saying so is the point: the previous version of this comment
// claimed the records were copied, which was true of the half that mattered and overstated for the
// rest.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const HOOK = path.join(REPO, '.claude/hooks/docs-aitells-gate.sh')

/** A transcript line carrying one tool call, in the field order the runtime actually writes. */
const record = (name, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } })

const EDIT = (file) => record('Edit', { replace_all: false, file_path: file, old_string: 'a', new_string: 'b' })
const WRITE = (file) => record('Write', { file_path: file, content: 'x' })
/** `edits` before `file_path`: the order a regex scoped with `[^}]*` could never reach. */
const MULTI_EDIT = (file) => record('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }], file_path: file })
const AI_TELLS = record('Skill', { skill: 'ai-tells', args: 'en detect' })

/** Run the gate over a transcript built from `lines`. Returns its stdout (a JSON verdict, or ''). */
function run(lines, { stopHookActive = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aitells-'))
  const tx = path.join(dir, 'transcript.jsonl')
  writeFileSync(tx, lines.join('\n') + '\n')
  try {
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: tx, stop_hook_active: stopHookActive }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const blocked = (lines, opts) => {
  const out = run(lines, opts)
  return out !== '' && JSON.parse(out).decision === 'block'
}

describe('which docs edits the gate can see', () => {
  it('sees one made with Edit, where file_path is not the first key', () => {
    // The regression this file exists for. `Edit` is how an existing document is changed.
    expect(blocked([EDIT('/repo/docs/guide/agent.md')])).toBe(true)
  })

  it('sees one made with Write', () => {
    expect(blocked([WRITE('/repo/docs/guide/agent.md')])).toBe(true)
  })

  it('sees a translated doc under docs/ko', () => {
    expect(blocked([EDIT('/repo/docs/ko/guide/agent.md')])).toBe(true)
  })

  it('sees Markdown at any depth under docs/', () => {
    // The prose said `docs/*.md`, which in a reader's head excludes a nested path even though the
    // shell glob and the jq filter both take it. Every doc in this repo is nested.
    for (const f of ['/repo/docs/a.md', '/repo/docs/guide/agent.md', '/repo/docs/ko/reference/cli.md']) {
      expect(blocked([EDIT(f)]), f).toBe(true)
    }
  })

  it('does not fire on an edit outside docs/', () => {
    expect(blocked([EDIT('/repo/packages/relay/src/server.ts'), WRITE('/repo/AGENTS.md')])).toBe(false)
  })

  it('sees a MultiEdit whose file_path comes after its edits', () => {
    // The order a `[^}]*` scan cannot reach, because the `}` closing the first edit ends the scan.
    // `MultiEdit` writes no records on this machine today, which is exactly why a half-blind matcher
    // for it would go unnoticed if it came back.
    expect(blocked([MULTI_EDIT('/repo/docs/guide/agent.md')])).toBe(true)
  })

  it('counts only .md, not every suffix that starts with it', () => {
    for (const f of ['/repo/docs/a.mdx', '/repo/docs/a.md.bak', '/repo/docs/a.markdown']) {
      expect(blocked([EDIT(f)]), f).toBe(false)
    }
  })

  it('does not depend on the transcript being written without spaces', () => {
    // The runtime writes compact JSON today. A matcher that only works because of that is one
    // serialisation change away from counting zero, which is the regression this file is about.
    const spaced = JSON.stringify(JSON.parse(EDIT('/repo/docs/guide/agent.md')), null, 1)
      .replace(/\n\s*/g, ' ')
    expect(blocked([spaced])).toBe(true)
  })

  it('does not fire on a docs path that is only mentioned in the replaced text', () => {
    // `[^}]*` keeps the match inside the same `input` object, so a source edit whose old_string
    // quotes a docs path is not a docs edit. Scoping to the whole line would have counted it.
    const line = record('Edit', {
      replace_all: false,
      file_path: '/repo/packages/relay/src/server.ts',
      old_string: 'see docs/guide/agent.md',
      new_string: 'see the guide',
    })
    expect(blocked([line])).toBe(false)
  })
})

describe('the hook agrees with a real parse of the same transcript', () => {
  // **The oracle.** Every case above asserts one shape at a time, which is how a matcher and its
  // tests come to agree with each other about a wrong shape — the failure this whole file exists
  // for. This one computes the answer independently, by parsing, and asks the hook to match it.
  const CORPUS = [
    EDIT('/repo/docs/guide/agent.md'),
    WRITE('/repo/docs/ko/guide/agent.md'),
    MULTI_EDIT('/repo/docs/reference/cli.md'),
    EDIT('/repo/packages/relay/src/server.ts'),
    EDIT('/repo/docs/a.mdx'),
    record('Edit', { replace_all: false, file_path: '/repo/src/x.ts', old_string: 'docs/guide/agent.md', new_string: '' }),
    'not json at all',
  ]

  /** What a JSON parse says the answer is, with no regard for how the line is spelled. */
  const byParsing = (lines) => lines.filter((line) => {
    let rec
    try { rec = JSON.parse(line) } catch { return false }
    return (rec.message?.content ?? []).some((c) =>
      c.type === 'tool_use'
      && ['Edit', 'Write', 'MultiEdit'].includes(c.name)
      && /\/docs\/.*\.md$/.test(c.input?.file_path ?? ''))
  }).length

  it('blocks exactly when a parse finds a docs edit', () => {
    expect(byParsing(CORPUS), 'three docs edits, three decoys, one unparseable line').toBe(3)
    expect(blocked(CORPUS)).toBe(true)
    expect(blocked(CORPUS.filter((l) => byParsing([l]) === 0)), 'decoys alone').toBe(false)
  })
})

describe('what satisfies it', () => {
  it('an ai-tells run in the same session', () => {
    expect(blocked([EDIT('/repo/docs/guide/agent.md'), AI_TELLS])).toBe(false)
  })

  it('but not the reminder text that merely names the skill', () => {
    // The reminder is injected into the transcript and says "run /ai-tells detect". Matching on the
    // prose rather than the invocation key would let the gate satisfy itself.
    const reminder = JSON.stringify({ message: { content: [{ type: 'text', text: 'Run /ai-tells detect before finishing.' }] } })
    expect(blocked([EDIT('/repo/docs/guide/agent.md'), reminder])).toBe(true)
  })
})

describe('it fails open where it must', () => {
  it('passes when re-entered after its own block', () => {
    // Without this a scripting error blocks the session forever.
    expect(blocked([EDIT('/repo/docs/guide/agent.md')], { stopHookActive: true })).toBe(false)
  })

  it('passes when the transcript is missing', () => {
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: '/nowhere/at/all.jsonl' }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('passes on a payload it cannot parse', () => {
    const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env } })
    expect(r.status, 'a Stop hook that dies would block every session').toBe(0)
  })
})

describe('the message reaches a contributor who does not read Korean', () => {
  // `.claude/` is committed, so these hooks fire for anyone working in the repo with Claude Code —
  // #698 arrived from a first-time contributor carrying a `.work/reviews/` record, which exists only
  // because a hook demanded one. A block written in Korean is unreadable to exactly the people
  // AGENTS.md says to write English for.
  it('blocks in English', () => {
    const out = run([EDIT('/repo/docs/guide/agent.md')])
    expect(JSON.parse(out).reason).not.toMatch(/[가-힣]/)
  })
})
