// The gate that makes a split-out issue name what it came from.
//
// **Every case below was a bypass in the shell version this replaces**, which is the reason the file
// exists: the first draft matched strings in the whole command and its own review record admitted it
// was untested. Three of its four rules were wrong in the same way, and none of them was visible
// without running it.
//
// The last describe spawns the real hook rather than the library, because a correct decision reached
// through a prefilter that never calls it is not a gate.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { judge, issueCreateInvocations, hasParent, hasStandalone } from '../lib/issue-parent.mjs'
import { tokenize, bodyFileArg, bodyArg, titleArg, heredocs, readBodyFile } from '../lib/gh-command.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const PARENT = 'Parent: #607'

/** `judge` with no filesystem: every body is supplied inline, keyed as the command writes it. The
 *  reader is handed a resolved path, so the keys are resolved to match. */
const verdict = (cmd, files = {}) => judge(cmd, (p) => {
  const key = Object.keys(files).find((k) => path.resolve(k) === p)
  if (key === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
  return files[key]
})

describe('which commands are issue creations', () => {
  const CREATES = {
    'the plain form': 'gh issue create --title x --body "Parent: #607"',
    'the undocumented `new` alias, which gh accepts': 'gh issue new --body "Parent: #607"',
    'behind an environment assignment': 'GH_REPO=o/r gh issue create --body "Parent: #607"',
    'behind two of them': 'A=1 GH_REPO=o/r gh issue create --body "Parent: #607"',
    'behind env(1)': 'env GH_REPO=o/r gh issue create --body "Parent: #607"',
    'after a separator': 'git status && gh issue create --body "Parent: #607"',
    'inside a subshell': '( gh issue create --body "Parent: #607" )',
  }
  for (const [name, cmd] of Object.entries(CREATES)) {
    it(`sees ${name}`, () => {
      expect(issueCreateInvocations(cmd)).toHaveLength(1)
    })
  }

  const NOT_CREATES = {
    'listing issues': 'gh issue list --state open',
    'viewing one': 'gh issue view 607 --json body',
    'a PR, not an issue': 'gh pr create --body-file /tmp/x.md',
    'the words inside an argument': 'echo "run gh issue create to file one"',
    'the words in a grep pattern': "grep -rn 'gh issue create' docs/",
  }
  for (const [name, cmd] of Object.entries(NOT_CREATES)) {
    it(`ignores ${name}`, () => {
      // Asserting a present count of zero rather than "nothing happened": these run through the same
      // tokenizer, so a broken tokenizer cannot pass this by returning early.
      expect(issueCreateInvocations(cmd)).toEqual([])
    })
  }
})

describe('an invocation ends where the command does', () => {
  it('does not borrow a later command\'s flags', () => {
    // `words.slice(j)` ran to the end of the token list, so `echo`'s `--body` counted as the issue's
    // and an invocation with no body at all was allowed.
    expect(verdict('gh issue create --web && echo --body "Parent: #607"').blocked).toBe(true)
    expect(verdict('gh issue create --web ; cat "Parent: #607"').blocked).toBe(true)
  })

  it('still judges each invocation in a chain on its own body', () => {
    const both = 'gh issue create --body "Parent: #607" && gh issue create --body "Parent: #608"'
    expect(verdict(both).blocked).toBe(false)
    const second = 'gh issue create --body "Parent: #607" && gh issue create --body "a bug"'
    expect(verdict(second).blocked, 'the second one names nothing').toBe(true)
  })
})

describe('where the body comes from', () => {
  it('reads a quoted --body-file path whole', () => {
    // `-F "issue body.md"` used to be cut at the first space and read a file called `issue`, so a
    // correctly-filed issue was refused for a line its body already had.
    expect(bodyFileArg(tokenize('gh issue create -F "issue body.md"'))).toBe('issue body.md')
    expect(bodyFileArg(tokenize("gh issue create --body-file 'my issue.md'"))).toBe('my issue.md')
    expect(bodyFileArg(tokenize('gh issue create --body-file=body.md'))).toBe('body.md')
  })

  it('allows a body file that carries the line, and blocks one that does not', () => {
    const cmd = 'gh issue create -F "issue body.md"'
    expect(verdict(cmd, { 'issue body.md': `${PARENT}\n\ntext\n` }).blocked).toBe(false)
    expect(verdict(cmd, { 'issue body.md': 'raised by the review of #647\n' }).blocked).toBe(true)
  })

  it('does not let a --title stand in for the body', () => {
    // The whole command used to be the haystack, so the gate could be satisfied by text that never
    // reached the issue.
    expect(verdict('gh issue create --title "Parent: #607" --body "a bug"').blocked).toBe(true)
  })

  it('blocks when no body can be read at all', () => {
    expect(verdict('gh issue create --title x').blocked).toBe(true)
    expect(verdict('gh issue create --body-file /nope.md').blocked).toBe(true)
  })

  it('reads a heredoc, whose body exists only in the command', () => {
    expect(verdict(`gh issue create --body-file - <<EOF\n${PARENT}\nEOF`).blocked).toBe(false)
    expect(verdict('gh issue create --body-file - <<EOF\nnothing\nEOF').blocked).toBe(true)
    expect(verdict(`gh issue create --body-file - <<'EOF'\n${PARENT}\nEOF`).blocked, 'quoted delimiter').toBe(false)
  })

  it('reads the payload rather than the command around it', () => {
    // The title bypass again, one case over: `body = cmd` let a `Parent:` line in a title-side
    // heredoc satisfy a check about the body.
    const cmd = `gh issue create --title "$(cat <<T\n${PARENT}\nT\n)" --body-file - <<B\nno parent here\nB`
    expect(heredocs(cmd), 'both payloads, in order').toEqual([PARENT, 'no parent here'])
    expect(verdict(cmd).blocked).toBe(true)
  })

  it('blocks rather than guessing when a command carries several heredocs', () => {
    // Picking one would be a guess, and the wrong guess is the permissive one.
    expect(verdict(`gh issue create --body-file - <<A\n${PARENT}\nA\ncat <<B\nx\nB`).blocked).toBe(true)
  })
})

describe('what counts as naming a parent', () => {
  it('takes the line on its own, with or without an owner/repo prefix', () => {
    expect(hasParent(`intro\n\n${PARENT}\n`)).toBe(true)
    expect(hasParent('Parent: jo-duchan/tapflow#607')).toBe(true)
  })

  it('refuses a half-written cross-repository reference', () => {
    // The prefix used to be any run of the characters an owner/repo contains, so neither of these
    // was a reference and both switched the gate off.
    expect(hasParent('Parent: owner#607')).toBe(false)
    expect(hasParent('Parent: /#607')).toBe(false)
    expect(hasParent('Parent: owner/#607')).toBe(false)
  })

  const NOT_A_PARENT = {
    'prose that mentions the issue': 'Raised by the review of #647.',
    'the words mid-sentence': 'Its Parent: #607 is where this came from.',
    'inside a fenced block': `Write it like this:\n\n\`\`\`\n${PARENT}\n\`\`\`\n`,
    'inside a tilde fence': `Write it like this:\n\n~~~\n${PARENT}\n~~~\n`,
    'inside an indented block': `Write it like this:\n\n    ${PARENT}\n`,
    'quoted inline': `Put \`${PARENT}\` in the body.`,
    'no number': 'Parent: #',
  }
  for (const [name, body] of Object.entries(NOT_A_PARENT)) {
    it(`refuses: ${name}`, () => {
      expect(hasParent(body)).toBe(false)
    })
  }

  // The exact shape AGENTS.md prints. If this ever counted, documenting the convention would satisfy
  // the gate for whoever documents it — the failure `changesetReason.test.mjs` already names.
  it('refuses the snippet as AGENTS.md prints it', () => {
    expect(hasParent('Every split-out issue names its parent, on a line of its own: `Parent: #607`.')).toBe(false)
  })
})

describe('what counts as standing alone', () => {
  it('takes a marker with a reason', () => {
    expect(hasStandalone('<!-- standalone: reported by a user -->')).toBe(true)
  })

  it('refuses one with no reason, which is the marker without the decision', () => {
    expect(hasStandalone('<!-- standalone: -->')).toBe(false)
    expect(hasStandalone('<!-- standalone:  -->')).toBe(false)
  })

  it('refuses an unterminated marker', () => {
    expect(hasStandalone('<!-- standalone: forgot the close')).toBe(false)
  })

  it('refuses one quoted in a fenced block', () => {
    expect(hasStandalone('Say:\n\n```\n<!-- standalone: a reason -->\n```\n')).toBe(false)
  })
})

describe('the hook itself, spawned', () => {
  const run = (cmd) => spawnSync('bash', [path.join(REPO, '.claude/hooks/issue-parent-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  it('blocks a bare issue and says what to add', () => {
    const r = run('gh issue create --title x --body "a bug"')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/Parent: #607/)
  })

  it('allows one that names its parent', () => {
    expect(run(`gh issue create --title x --body "${PARENT}"`).status).toBe(0)
  })

  it('allows an unrelated command without paying for node', () => {
    // The prefilter's job. `git status` never reaches the decision, which is why it can afford to be
    // a node process.
    expect(run('git status --short').status).toBe(0)
  })

  it('fails open on a payload it cannot parse', () => {
    const r = spawnSync('bash', [path.join(REPO, '.claude/hooks/issue-parent-gate.sh')], {
      input: 'not json at all, gh issue create',
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status, 'a malformed payload would block every Bash call in the session').toBe(0)
  })
})

// ── Added with the gate-misdiagnosis work ───────────────────────────────────────────────────────

/** `gh issue create`, assembled rather than written, so this file can be edited from a heredoc. */
const CREATE = ['gh', 'issue', 'create'].join(' ')

describe('a blocked command is told which rule it broke', () => {
  // **Both failures printed one constant.** The decision layer separated them from the first commit
  // and the entrypoint dropped `detail`, so a body file the gate could not open was reported as a
  // body naming no parent — and the author goes off to add a line that is already there. Measured
  // filing #700: the body had `Parent: #609` on its own line the whole time.
  it('separates an unreadable body file from a body that names nothing', () => {
    expect(verdict(`${CREATE} --body-file rel.md`).reason).toBe('unreadable-body-file')
    expect(verdict(`${CREATE} --body "a bug"`).reason).toBe('no-parent')
  })

  it('separates a body file it could not read from no body at all', () => {
    expect(verdict(`${CREATE} --title x`).reason).toBe('no-body')
  })

  it('names the path it tried, resolved', () => {
    // The hook judges from `CLAUDE_PROJECT_DIR`, so a relative `--body-file` is resolved against the
    // repo root rather than the cwd the command would actually run in. Following the command's own
    // `cd` would be guessing; saying which path was opened is not, and it is the whole fix.
    expect(verdict(`${CREATE} --body-file rel.md`).detail).toContain(path.resolve('rel.md'))
  })

  it('still blocks all three', () => {
    // The reasons are for the message. Nothing about which rule broke may change whether it blocks.
    for (const cmd of [`${CREATE} --body-file rel.md`, `${CREATE} --title x`, `${CREATE} --body "a bug"`]) {
      expect(verdict(cmd).blocked, cmd).toBe(true)
    }
  })
})

describe('a heredoc payload is text, not a command', () => {
  it('does not read an invocation written inside one', () => {
    // Found by being blocked from writing the plan document for this change: its prose carried
    // `&& gh issue create --body-file rel.md` as an example, and a heredoc payload tokenizes as bare
    // words, so that line landed in command position. Quoting is what saves `echo "…"` and the grep
    // pattern above; nothing was saving a heredoc, and the file's own header claims this case works.
    const doc = ['cat > plan.md <<EOF', 'Repro:', `A) cd /elsewhere && ${CREATE} --body-file rel.md`, 'EOF'].join('\n')
    expect(issueCreateInvocations(doc)).toEqual([])
  })

  it('reads the payload when the invocation outside it is real', () => {
    // Two different questions, and the fix to the first must not answer the second. The payload is
    // not where invocations live, and it is exactly where `--body-file -` gets its body.
    expect(verdict(`${CREATE} --body-file - <<EOF\n${PARENT}\nEOF`).blocked).toBe(false)
    expect(verdict(`${CREATE} --body-file - <<EOF\nnothing\nEOF`).blocked).toBe(true)
  })

  it('is not fooled by an unterminated one', () => {
    // No terminator means no payload anyone can read, which `heredocs` already decides. Leaving the
    // text scannable fails toward blocking, which is the safe direction for a gate.
    expect(issueCreateInvocations(`${CREATE} --title x <<EOF\nstill the same command`)).toHaveLength(1)
  })
})

describe('a newline begins a command', () => {
  it('sees an invocation on a line of its own', () => {
    // **A hole, not a nuisance.** `SEPARATOR` carried `;`, `&&` and `|` but not the newline, so
    // command position never reset across lines and a multi-line Bash call — the ordinary shape for
    // anything with a heredoc or a long flag list — walked straight past the gate.
    const cmd = `git status\n${CREATE} --title x --body "a bug"`
    expect(issueCreateInvocations(cmd)).toHaveLength(1)
    expect(verdict(cmd).blocked).toBe(true)
  })

  it('judges each line-separated invocation on its own body', () => {
    expect(verdict(`${CREATE} --body "${PARENT}"\n${CREATE} --body "a bug"`).blocked).toBe(true)
    expect(verdict(`${CREATE} --body "${PARENT}"\n${CREATE} --body "${PARENT}"`).blocked).toBe(false)
  })

  it('does not treat a newline inside a quoted argument as one', () => {
    // The tokenizer resolves quotes first, so a body with paragraphs stays one word.
    expect(verdict(`${CREATE} --body "intro\n\n${PARENT}\n"`).blocked).toBe(false)
  })
})

describe('the hook reports the reason it decided on', () => {
  const run = (cmd) => spawnSync('bash', [path.join(REPO, '.claude/hooks/issue-parent-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  it('does not answer an unreadable body file with the parent rule', () => {
    const r = run(`${CREATE} --title x --body-file nowhere-at-all.md`)
    expect(r.status).toBe(2)
    expect(r.stderr, 'the misdiagnosis this change exists for').not.toMatch(/names no parent/i)
    expect(r.stderr, 'and it says which path it opened').toContain(path.join(REPO, 'nowhere-at-all.md'))
  })

  it('still answers a parentless body with the parent rule', () => {
    const r = run(`${CREATE} --title x --body "a bug"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/names no parent/i)
    expect(r.stderr).toMatch(/Parent: #607/)
  })
})

// ── Added after the adversarial review of this branch ───────────────────────────────────────────

describe('an operator does not need a space to end a command', () => {
  // **Every one of these is valid shell and hid the invocation completely.** `tokenize` split on
  // whitespace alone, so an operator glued to `gh` stayed inside that word and command position was
  // never reached. `ASSIGNMENT` made the commonest form worse rather than better: `URL=$(gh` is a
  // prefix match, so the mechanism added to see through `GH_REPO=o/r gh issue create` swallowed the
  // capture form whole. Predates this branch; found by the review of it.
  const GLUED = {
    'a command substitution': `URL=$(${CREATE} --title t --body "a bug")`,
    'an unspaced &&': `true&&${CREATE} --title t --body "a bug"`,
    'an unspaced ;': `cd /tmp;${CREATE} --title t --body "a bug"`,
    'an unspaced subshell': `(${CREATE} --title t --body "a bug")`,
    'an unspaced pipe': `echo x|${CREATE} --body "a bug"`,
  }
  for (const [name, cmd] of Object.entries(GLUED)) {
    it(`sees one behind ${name}`, () => {
      expect(issueCreateInvocations(cmd)).toHaveLength(1)
      expect(verdict(cmd).blocked, 'and judges it').toBe(true)
    })
  }

  it('sees one behind xargs, which keeps the next word in command position', () => {
    expect(issueCreateInvocations(`echo t | xargs ${CREATE} --body "a bug"`)).toHaveLength(1)
  })

  it('still ends the slice at the operator that follows, spaced or not', () => {
    // The borrowed-flags case, now reachable without spaces: `echo`'s --body must not count as this
    // invocation's.
    expect(verdict(`${CREATE} --web&&echo --body "${PARENT}"`).blocked).toBe(true)
  })

  it('does not treat an operator inside a quoted argument as one', () => {
    expect(verdict(`${CREATE} --body "${PARENT}" --title "a && b | c;"`).blocked).toBe(false)
  })
})

describe('a heredoc opener ends its line', () => {
  it('does not strip on a `<<` written inside an argument', () => {
    // Introduced by the payload strip and caught by review. `<<EOF` matched anywhere on a line, so a
    // command that merely *mentions* one began deleting lines until a later heredoc supplied the
    // terminator — and took a real invocation with it. Requiring the opener to end its line
    // separates the two, and the conservative direction of that rule is to strip nothing, which
    // leaves the text scanned rather than skipped.
    const cmd = [
      'grep -n "<<EOF" scripts/lib/gh-command.mjs',
      `${CREATE} --title x --body "a bug"`,
      "cat > /tmp/n.md <<'EOF'",
      'text',
      'EOF',
    ].join('\n')
    expect(issueCreateInvocations(cmd)).toHaveLength(1)
    expect(verdict(cmd).blocked).toBe(true)
  })

  it('still strips a real one, quoted delimiter and all', () => {
    expect(verdict(`${CREATE} --body-file - <<'EOF'\n${PARENT}\nEOF`).blocked).toBe(false)
  })

  it('reads CRLF line endings the same way it reads LF', () => {
    // `heredocs` split on /\r?\n/ while the strip split on '\n', so under CRLF the terminator line
    // was `EOF\r`, never matched, and the payload was kept — bringing back the exact prose
    // regression this branch exists to fix, on the line endings a Windows contributor produces.
    // The terminator must not be the last line: joining three lines leaves the final `EOF` without
    // its `\r`, which matches the delimiter by accident and strips the payload for the wrong reason.
    // That shape passed under the mutation, which is how this probe was found to be measuring nothing.
    const doc = [`cat > plan.md <<'EOF'`, `A) cd /elsewhere && ${CREATE} --body-file rel.md`, 'EOF', 'echo done']
    expect(issueCreateInvocations(doc.join('\r\n')), 'CRLF').toEqual([])
    expect(issueCreateInvocations(doc.join('\n')), 'LF').toEqual([])
  })
})

describe('a short flag may carry its value', () => {
  // pflag accepts a shorthand's value attached to it, verified against the binary: `gh issue list
  // -Lx` answers `invalid argument "x" for "-L, --limit" flag`. The readers matched only an exact
  // `-F`/`-b`/`-t` token or `--long=`, so a correctly-filed issue was refused for a body it does
  // have — and the language gate, which shares these readers, saw no text to check at all.
  it('reads a value attached to the shorthand', () => {
    expect(bodyFileArg(tokenize(`${CREATE} -F/tmp/body.md`))).toBe('/tmp/body.md')
    expect(bodyFileArg(tokenize(`${CREATE} -F-`)), 'stdin').toBe('-')
    expect(bodyArg(tokenize(`${CREATE} -b"${PARENT}"`))).toBe(PARENT)
    expect(titleArg(tokenize(`${CREATE} -t"a title"`))).toBe('a title')
  })

  it('does not read a long flag as a shorthand carrying a value', () => {
    // `'--title'.startsWith('-t')`, so the prefix rule has to refuse a double dash or it answers
    // `itle` for every long spelling the gate was already reading correctly.
    expect(titleArg(tokenize(`${CREATE} --title x`))).toBe('x')
    expect(bodyArg(tokenize(`${CREATE} --body y`))).toBe('y')
    expect(bodyFileArg(tokenize(`${CREATE} --body-file z`))).toBe('z')
    expect(bodyFileArg(tokenize(`${CREATE} --body-file=z`))).toBe('z')
  })

  it('allows an issue whose body arrives that way, and blocks one that does not', () => {
    expect(verdict(`${CREATE} -b"${PARENT}"`).blocked).toBe(false)
    expect(verdict(`${CREATE} -b"a bug"`).reason).toBe('no-parent')
  })
})

describe('an unreadable body file is told why', () => {
  const run = (cmd, cwd = REPO) => spawnSync('bash', [path.join(REPO, '.claude/hooks/issue-parent-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  // **One message for every errno reproduced this fix's own defect inside it.** A typo in an
  // absolute path, a directory and a permissions failure were all answered with "pass an absolute
  // path", which the author already had.
  it('separates a missing absolute path from a relative one', () => {
    expect(run(`${CREATE} --title T --body-file /nowhere/at/all.md`).stderr).toMatch(/No file is there/)
    expect(run(`${CREATE} --title T --body-file rel.md`).stderr).toMatch(/relative to the directory/)
  })

  it('names a directory and a permissions failure as themselves', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-'))
    expect(run(`${CREATE} --title T --body-file ${dir}`).stderr).toMatch(/is a directory/)

    const locked = path.join(dir, 'locked.md')
    writeFileSync(locked, 'x')
    chmodSync(locked, 0o000)
    expect(run(`${CREATE} --title T --body-file ${locked}`).stderr).toMatch(/permissions/)
    chmodSync(locked, 0o644)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a relative body file from the checkout the session is in', () => {
    // The hook runs from the repository root while `gh` runs where the session is, so resolving
    // against the payload's cwd is what lets a relative path be read at all rather than reported.
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-'))
    writeFileSync(path.join(dir, 'body.md'), `${PARENT}\n`)
    expect(run(`${CREATE} --title T --body-file body.md`, dir).status).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('a body file that is not a regular file', () => {
  // **A gate that hangs is worse than one that blocks.** `readFileSync` on a FIFO with no writer
  // blocks until the hook times out, and the language gate reaching body files put that on the
  // `gh pr create` path for the first time. `statSync` does not open the file, so it answers at once.
  it('answers instead of blocking on a FIFO', () => {
    // **Read in a child process, on purpose.** `readFileSync` is synchronous, so without the guard
    // it blocks the worker thread and vitest's own `testTimeout` cannot interrupt it — the suite
    // hangs rather than failing, which turns a regression into a stopped CI job instead of a red
    // one. The child carries the timeout, so a missing guard shows up as `killed`.
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-'))
    const fifo = path.join(dir, 'body.md')
    spawnSync('mkfifo', [fifo])
    try {
      const r = spawnSync(process.execPath, [
        '--input-type=module',
        '-e',
        `import { readBodyFile } from ${JSON.stringify(path.join(REPO, 'scripts/lib/gh-command.mjs'))}
         try { readBodyFile(${JSON.stringify(fifo)}); console.log('read') }
         catch (e) { console.log('threw:' + e.code) }`,
      ], { encoding: 'utf8', timeout: 4000 })
      expect(r.signal, 'the reader blocked on a FIFO instead of answering').toBeNull()
      expect(r.stdout.trim()).toBe('threw:ENOTFILE')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)

  it('gives a directory its own errno so the message can name it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-'))
    try {
      expect(() => readBodyFile(dir)).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a command reached through a control condition', () => {
  // `if`, `elif`, `while` and `until` take a command as their condition, so the word after one is in
  // command position — the mirror of `then`/`do`/`else`, which were separators from the start.
  // Without them `if gh issue create …; then` was invisible to both gates.
  for (const kw of ['if', 'elif', 'while', 'until']) {
    it(`is seen after \`${kw}\``, () => {
      const cmd = `${kw} ${CREATE} --title x --body "a bug"; then :; fi`
      expect(issueCreateInvocations(cmd)).toHaveLength(1)
      expect(verdict(cmd).blocked).toBe(true)
    })
  }
})

describe('a scalar flag given twice', () => {
  it('is read the way pflag reads it — the last one wins', () => {
    // Reading the first let a command satisfy the gate with text GitHub would never receive:
    // `--body "Parent: #607" --body "a bug"` sends the second.
    expect(verdict(`${CREATE} --title x --body "${PARENT}" --body "a bug"`).blocked).toBe(true)
    expect(verdict(`${CREATE} --title x --body "a bug" --body "${PARENT}"`).blocked).toBe(false)
    expect(bodyFileArg(tokenize(`${CREATE} -F first.md --body-file second.md`))).toBe('second.md')
  })
})

describe('a body file the command writes before sending it', () => {
  it('is judged from the heredoc that targets it, not from the disk', () => {
    const cmd = `cat > b.md <<'EOF'\n${PARENT}\nEOF\n\n${CREATE} --title x -F b.md`
    expect(verdict(cmd, { 'b.md': 'no parent on disk' }).blocked, 'the pending write carries it').toBe(false)
  })

  it('does not take an unrelated heredoc for the body', () => {
    const cmd = `cat > notes.md <<'EOF'\n${PARENT}\nEOF\n\n${CREATE} --title x -F b.md`
    expect(verdict(cmd, { 'b.md': 'no parent on disk' }).blocked, 'notes.md is not the body').toBe(true)
  })

  it('reads a quoted redirection target', () => {
    const cmd = `cat > "my body.md" <<'EOF'\n${PARENT}\nEOF\n\n${CREATE} --title x -F "my body.md"`
    expect(verdict(cmd).blocked).toBe(false)
  })

  it('does not read `2>&1` as a redirection target', () => {
    const cmd = `cat > b.md 2>&1 <<'EOF'\n${PARENT}\nEOF\n\n${CREATE} --title x -F b.md`
    expect(verdict(cmd).blocked).toBe(false)
  })
})

describe('the prefilter matches what the shell would leave', () => {
  const run = (cmd) => spawnSync('bash', [path.join(REPO, '.claude/hooks/issue-parent-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd }, cwd: REPO }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  // The prefilter reads raw text and the parser reads a tokenized command, so a spelling that only
  // becomes `gh issue create` after quote removal was a real invocation the gate exited before
  // seeing. Squashing the characters the shell strips costs nothing, because it can only widen what
  // reaches the parser — and the parser is what decides.
  const SPELLINGS = {
    'a double-quoted break': 'g"h" issue create --title x --body "a bug"',
    'a single-quoted break': "g'h' issue create --title x --body 'a bug'",
    'a break in the noun': 'gh iss"ue" create --title x --body "a bug"',
    'a backslash escape': 'g\\h issue create --title x --body "a bug"',
  }
  for (const [name, cmd] of Object.entries(SPELLINGS)) {
    it(`reaches the parser through ${name}`, () => {
      expect(run(cmd).status).toBe(2)
    })
  }

  it('still lets an unrelated command past without paying for node', () => {
    // The widening has to stay narrow enough to be worth having. These are the shapes the prefilter
    // exists for, and none of them contains the pair after squashing.
    for (const cmd of ['rg -n "highlight" --pretty src', 'npm run build 2>&1 | grep -i high', 'git status --short']) {
      expect(run(cmd).status, cmd).toBe(0)
    }
  })
})
