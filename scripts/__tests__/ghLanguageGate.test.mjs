// The gate that keeps PR and issue titles and bodies in English.
//
// **It replaces a one-line perl regex over the whole command**, which is the same mistake the issue
// parent gate was written to end and which this file's first case is named after: a `node -e` script
// with `gh issue create` inside a *string literal* was refused as an issue creation, because the
// pattern matched text rather than a command. The parser next door already knew the difference.
//
// The port also closes the opposite hole. The old regex saw only the command text, so Korean typed
// inline was caught while Korean in a `--body-file` sailed through — the gate was strictest about
// the shape that is easiest to avoid.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { judge, authoringInvocations, koreanLine } from '../lib/gh-language.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const KO = '한글 본문'

/** Assembled rather than written, so this file can be edited from a heredoc. */
const PR_CREATE = ['gh', 'pr', 'create'].join(' ')
const ISSUE_CREATE = ['gh', 'issue', 'create'].join(' ')

/** `judge` with no filesystem: every body file is supplied inline, keyed as the command writes it.
 *  The reader is handed a resolved path, so the keys are resolved to match. */
const verdict = (cmd, files = {}) => judge(cmd, (p) => {
  const key = Object.keys(files).find((k) => path.resolve(k) === p)
  if (key === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
  return files[key]
})

describe('which commands author something on GitHub', () => {
  const AUTHORS = {
    'creating a PR': `${PR_CREATE} --title x`,
    'editing a PR': 'gh pr edit 42 --body x',
    'creating an issue': `${ISSUE_CREATE} --title x`,
    'editing an issue': 'gh issue edit 42 --body x',
    'the undocumented `new` alias': 'gh issue new --title x',
    'behind an environment assignment': `GH_REPO=o/r ${PR_CREATE} --title x`,
    'after a separator': `git status && ${PR_CREATE} --title x`,
  }
  for (const [name, cmd] of Object.entries(AUTHORS)) {
    it(`sees ${name}`, () => {
      expect(authoringInvocations(cmd)).toHaveLength(1)
    })
  }

  const NOT_AUTHORS = {
    'listing PRs': 'gh pr list --state open',
    'viewing one': 'gh pr view 42 --json body',
    'checking one out': 'gh pr checkout 42',
    'commenting': 'gh pr comment 42 --body x',
    'the words inside a script string': `node -e "import { judge } from './lib.mjs'; judge('${ISSUE_CREATE} --title x')"`,
    'the words in a grep pattern': `grep -rn '${PR_CREATE}' docs/`,
    'the words in a heredoc payload': `cat > plan.md <<EOF\nRun ${PR_CREATE} when ready\nEOF`,
  }
  for (const [name, cmd] of Object.entries(NOT_AUTHORS)) {
    it(`ignores ${name}`, () => {
      // A present count of zero rather than "nothing happened": these run through the same parser,
      // so a parser that returned early could not pass this by finding nothing.
      expect(authoringInvocations(cmd)).toEqual([])
    })
  }
})

describe('Korean is judged where it reaches GitHub, and nowhere else', () => {
  it('blocks it in a title', () => {
    expect(verdict(`${PR_CREATE} --title "${KO}" --body "in English"`)).toMatchObject({ blocked: true })
  })

  it('blocks it in a body', () => {
    expect(verdict(`${PR_CREATE} --title "x" --body "${KO}"`)).toMatchObject({ blocked: true })
  })

  it('blocks it in a body file, which the regex could not see at all', () => {
    // The hole the port closes. `--body-file` is the form CONTRIBUTING tells everyone to use, so the
    // old gate was blind in exactly the case the convention produces.
    expect(verdict(`${PR_CREATE} -F body.md`, { 'body.md': `## Summary\n\n${KO}\n` })).toMatchObject({ blocked: true })
  })

  it('blocks it in the heredoc that reaches `--body-file -`', () => {
    expect(verdict(`${PR_CREATE} --body-file - <<EOF\n${KO}\nEOF`)).toMatchObject({ blocked: true })
  })

  it('allows an English body file', () => {
    expect(verdict(`${PR_CREATE} -F body.md`, { 'body.md': '## Summary\n\nA fix.\n' }).blocked).toBe(false)
  })

  it('allows Korean that never reaches GitHub', () => {
    // The false positive that started this. Every one of these was refused by the regex.
    const elsewhere = [
      `${PR_CREATE} --title x --body "in English" && echo "${KO}"`,
      `node -e "console.log('${KO}'); // ${ISSUE_CREATE}"`,
      `grep -rn '${PR_CREATE}' docs/ # ${KO}`,
    ]
    for (const cmd of elsewhere) expect(verdict(cmd).blocked, cmd).toBe(false)
  })

  it('names where it found it, so the message can point at one thing', () => {
    expect(verdict(`${PR_CREATE} --title "${KO}" --body "en"`).where).toBe('--title')
    expect(verdict(`${PR_CREATE} --title "en" --body "${KO}"`).where).toBe('--body')
    expect(verdict(`${PR_CREATE} -F body.md`, { 'body.md': KO }).where).toContain('body.md')
  })
})

describe('what this gate cannot see', () => {
  it('lets an unreadable body file with no heredoc behind it through', () => {
    // **A floor, not a fence,** and the boundary is deliberate. The gate resolves against the
    // session's directory while the command may `cd` first, so a path can be readable to `gh` and
    // not to this. Blocking every such path would refuse correct work over a file the gate merely
    // could not open. What remains uncovered is a Korean body passed by a path only the command can
    // reach, with nothing in the command to read instead.
    expect(verdict(`${PR_CREATE} -F somewhere/else.md`).blocked).toBe(false)
  })

  it('lets a body built by a substitution through', () => {
    // `$(…)` is not resolved by the tokenizer and never will be. Named so the next reader does not
    // mistake silence here for coverage.
    expect(verdict(`${PR_CREATE} --body "$(cat ko.md)"`).blocked).toBe(false)
  })
})

describe('the hook itself, spawned', () => {
  const run = (cmd) => spawnSync('bash', [path.join(REPO, '.claude/hooks/gh-language-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  it('blocks a Korean title and says where it is', () => {
    const r = run(`${PR_CREATE} --title "${KO}" --body "en"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--title/)
  })

  it('allows the command that the regex refused', () => {
    expect(run(`node -e "judge('${ISSUE_CREATE}'); console.log('${KO}')"`).status).toBe(0)
  })

  it('allows an unrelated command without paying for node', () => {
    expect(run('git status --short').status).toBe(0)
  })

  it('fails open on a payload it cannot parse', () => {
    const r = spawnSync('bash', [path.join(REPO, '.claude/hooks/gh-language-gate.sh')], {
      input: `not json at all, ${PR_CREATE} ${KO}`,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status, 'a malformed payload would block every Bash call in the session').toBe(0)
  })
})

// ── Added after the adversarial review of this branch ───────────────────────────────────────────

describe('an English body may name a Korean string', () => {
  // **Merged PR #660 is the case.** Its body is 60+ lines of English with one line reading
  // `Renamed sidebar labels to "Network Control" and "네트워크 제어."` — and a codepoint test blocks
  // it, then advises rewriting that label in English, which would make the sentence false. The repo
  // ships `docs/ko/`, so naming Korean labels and paths is a live workflow rather than a
  // hypothetical. A line counts as Korean when its Hangul outnumbers its Latin letters.
  const PR660 = '  * Renamed sidebar labels to "Network Control" and "네트워크 제어."'

  it('allows the line #660 actually shipped', () => {
    expect(koreanLine(PR660)).toBeNull()
    expect(verdict(`${PR_CREATE} -F b.md`, { 'b.md': `## Summary\n\nEnglish.\n\n${PR660}\n` }).blocked).toBe(false)
  })

  it('still catches the sentence around it', () => {
    expect(koreanLine(`${PR660}\n사이드바 라벨 이름을 바꿨습니다.`)).toBe('사이드바 라벨 이름을 바꿨습니다.')
  })

  it('catches a title that is mostly Korean even with an English prefix', () => {
    expect(verdict(`${PR_CREATE} --title "docs: 네트워크 제어 가이드"`).blocked).toBe(true)
  })

  it('reports the offending line, not just the argument', () => {
    expect(verdict(`${PR_CREATE} --body "en line\n한글 문장입니다."`).line).toBe('한글 문장입니다.')
  })
})

describe('a body file the same command is about to write', () => {
  it('is judged from the heredoc, since the file does not exist yet', () => {
    // The headline hole, still open for the single-call shape: a heredoc writes the body and `gh`
    // sends it in the same Bash call, so at gate time there is no file to read and the Korean sat
    // unread in the payload. `lets an unreadable body file through` asserted the absence and locked
    // it in, which is why no mutation found it.
    const cmd = `cat > /tmp/nb.md <<'EOF'\n## Summary\n\n${KO}입니다.\nEOF\n\n${PR_CREATE} --title T --body-file /tmp/nb.md`
    expect(verdict(cmd).blocked).toBe(true)
  })

  it('allows the same shape with an English heredoc', () => {
    const cmd = `cat > /tmp/nb.md <<'EOF'\n## Summary\n\nA fix.\nEOF\n\n${PR_CREATE} --title T --body-file /tmp/nb.md`
    expect(verdict(cmd).blocked).toBe(false)
  })

  it('prefers the pending write to the stale file it replaces', () => {
    // **This assertion used to say the opposite, and the opposite was a bypass.** An English body on
    // disk, overwritten by a Korean heredoc in the same call: judging the file judges text that no
    // longer exists by the time `gh` runs. Written as "disk wins over the payload", it read like a
    // decision and was a hole with a test holding it open.
    const cmd = `cat > b.md <<'EOF'\n${KO}입니다.\nEOF\n\n${PR_CREATE} -F b.md`
    expect(verdict(cmd, { 'b.md': 'English on disk.' }).blocked).toBe(true)
  })

  it('does not blame an unrelated heredoc on the body file', () => {
    // The other half: with no target to match on, the command's only heredoc was assigned to a body
    // file whose contents were never read — and the message named that path.
    const cmd = `cat > notes.md <<'EOF'\n${KO}입니다.\nEOF\n\n${PR_CREATE} -F body.md`
    expect(verdict(cmd, { 'body.md': 'English body.' }).blocked).toBe(false)
    expect(verdict(cmd).blocked, 'nor when the body file cannot be read at all').toBe(false)
  })

  it('still judges the heredoc that writes a body file which does not exist yet', () => {
    const cmd = `cat > b.md <<'EOF'\n${KO}입니다.\nEOF\n\n${PR_CREATE} -F b.md`
    expect(verdict(cmd).blocked).toBe(true)
  })
})

describe('a short flag carrying its value reaches this gate too', () => {
  it('blocks Korean attached to the shorthand', () => {
    // The readers are shared with the parent gate, where missing this is a false block. Here it is a
    // bypass: no text found means nothing to check.
    expect(verdict(`${PR_CREATE} -t"${KO} 제목"`).blocked).toBe(true)
    expect(verdict(`${PR_CREATE} -b"${KO}입니다"`).blocked).toBe(true)
  })
})

describe('the hook resolves the checkout the session is in', () => {
  const runIn = (cmd, cwd, projectDir) => spawnSync('bash', [path.join(REPO, '.claude/hooks/gh-language-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  })

  it('still judges when CLAUDE_PROJECT_DIR points somewhere else', () => {
    // Deriving the root from the project dir alone turns the gate off for a session in a worktree,
    // or one whose project dir is stale: `scripts/` is not there, so the prefilter gives up. The
    // sibling review gate resolves this from the payload's cwd (#699); this one now does too.
    expect(runIn(`${PR_CREATE} --title "${KO} 제목"`, REPO, '/nope/nope').status).toBe(2)
  })

  it('falls back to the project dir when the cwd is not a checkout', () => {
    expect(runIn(`${PR_CREATE} --title "${KO} 제목"`, '/nope/nope', REPO).status).toBe(2)
  })

  it('reads the command out of the payload before matching it', () => {
    // **A source-text floor, and it says so.** The prefilter used to match the whole JSON payload,
    // whose `cwd` supplies words the command never had — in a checkout under `personal-project`,
    // `*gh*pr*` meant "contains gh", and `rg -n "highlight"` paid for a node process. The fix is
    // cost, not behaviour: both spellings exit 0 on such a command, so nothing observable from
    // outside can fail. Asserting the exit code here would read as coverage and be unable to fail,
    // which `contributing/test-and-guard-coverage.md` names as the shape to avoid. This checks the
    // one thing that is visible instead.
    const hook = readFileSync(path.join(REPO, '.claude/hooks/gh-language-gate.sh'), 'utf8')
    // Asserted on what the haystack is *derived from*, not on one spelling of it: the first version
    // pinned `case "$cmd" in` and broke the moment the same command was squashed into `$squashed`
    // first, which changed nothing about the property being held. That is the standing cost of a
    // source-text floor, and pinning the derivation is as close to the property as text gets.
    expect(hook, 'the haystack comes from the command').toMatch(/squashed=\$\{cmd\/\//)
    expect(hook, 'the payload is not the haystack').not.toMatch(/case "\$input" in/)
    expect(runIn('rg -n "highlight" --pretty src', REPO, REPO).status, 'and it still allows it').toBe(0)
  })
})

describe('the prefilter matches what the shell would leave', () => {
  const run = (cmd) => spawnSync('bash', [path.join(REPO, '.claude/hooks/gh-language-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd }, cwd: REPO }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  it('reaches the parser through a quoted break in the command word', () => {
    // Same hole as the issue-parent gate's, and the same one line closes it. Without it a Korean
    // title sails past on a spelling that is a real invocation everywhere except in the raw text.
    expect(run(`g"h" pr create --title "${KO} 제목"`).status).toBe(2)
    expect(run(`gh p"r" create --title "${KO} 제목"`).status).toBe(2)
  })

  it('still lets an unrelated command past', () => {
    expect(run('rg -n "highlight" --pretty src').status).toBe(0)
  })
})
