// The review gate judges the checkout the session is actually in.
//
// **Written because the permissive direction was reachable.** The gate resolved its branch by
// `cd`-ing to `CLAUDE_PROJECT_DIR` unconditionally, so a session working in a git worktree — the
// ordinary way to work while another session holds the main checkout — had its PR judged against
// whatever that checkout happened to be sitting on. Blocking is the harmless half. The other half is
// that a record for that unrelated branch, referencing its own HEAD, **satisfied the gate**, and the
// PR went out labelled reviewed with nothing having read its diff.
//
// The gate still does not know which branch `gh pr create --head X` names, and does not try: reading
// a branch out of an arbitrary shell command means handling quoting, heredocs and substitutions, and
// that limit predates this change rather than being introduced by it.
//
// The hook is a shell script fed JSON on stdin, so it is exercised exactly as Claude Code runs it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOOK = join(import.meta.dirname, '..', '..', '.claude', 'hooks', 'adversarial-review-gate.sh')
const CREATE = 'gh pr create --base main'

let repo, worktree, elsewhere, unborn, sha

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

/** Run the hook the way Claude Code does: JSON on stdin, exit code and stderr out. */
function gate(command, { cwd = repo, projectDir = repo, spawnIn } = {}) {
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    // `spawnIn` is the hook process's own directory, which only matters for the empty-cwd case:
    // `git -C ""` reads it, so the test has to be able to make it a repo that WOULD satisfy the gate.
    ...(spawnIn ? { cwd: spawnIn } : {}),
    encoding: 'utf8',
  })
  return { code: res.status, stderr: res.stderr ?? '' }
}

const recordPath = (dir, branch) => join(dir, '.work', 'reviews', `${branch.replaceAll('/', '__')}.md`)
const record = (dir, branch, hash) => {
  mkdirSync(join(dir, '.work', 'reviews'), { recursive: true })
  writeFileSync(recordPath(dir, branch), `head: ${hash}\n`)
}
const unrecord = (dir, branch) => {
  if (existsSync(recordPath(dir, branch))) rmSync(recordPath(dir, branch))
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gate-repo-'))
  elsewhere = mkdtempSync(join(tmpdir(), 'gate-notarepo-'))
  unborn = mkdtempSync(join(tmpdir(), 'gate-unborn-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: unborn })
  git('init', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  writeFileSync(join(repo, 'f.txt'), 'x')
  git('add', '-A')
  git('commit', '-m', 'one')
  sha = git('rev-parse', 'HEAD')
  mkdirSync(join(repo, 'sub'), { recursive: true })
  worktree = mkdtempSync(join(tmpdir(), 'gate-wt-'))
  rmSync(worktree, { recursive: true, force: true }) // `git worktree add` wants the path absent
  git('worktree', 'add', '-b', 'fix/other', worktree, 'HEAD')
  record(repo, 'main', sha)
})

afterAll(() => {
  for (const d of [repo, worktree, elsewhere, unborn]) rmSync(d, { recursive: true, force: true })
})

describe('the review gate', () => {
  it('reaches both verdicts, so nothing below passes vacuously', () => {
    // A hook that blocked everything would satisfy every refusal in this file, and one whose matcher
    // stopped firing would satisfy every pass. Both ends are pinned before anything else is claimed.
    expect(gate('echo hello').code, 'a command that creates no PR was gated').toBe(0)
    unrecord(repo, 'main')
    expect(gate(CREATE).code, 'a PR with no record was allowed').toBe(2)
    record(repo, 'main', sha)
    expect(gate(CREATE).code, 'a PR with a valid record was refused').toBe(0)
  })

  it('refuses a record that names a different commit', () => {
    record(repo, 'main', '0'.repeat(40))
    expect(gate(CREATE).stderr).toContain('does not reference the current HEAD')
    record(repo, 'main', sha)
  })

  it('does not take the sha out of a longer hex string', () => {
    // Unanchored, the match is satisfied by anything that merely contains the sha, which is not the
    // "reviewed code == PR code" the header promises. Both sides, since a boundary check can be
    // written to guard only one.
    for (const written of [`${sha}cafe`, `dead${sha}`]) {
      record(repo, 'main', written)
      expect(gate(CREATE).code, `a longer hex string passed: ${written}`).toBe(2)
    }
    // The control: the same sha with ordinary punctuation around it still counts.
    record(repo, 'main', `${sha}, verified`)
    expect(gate(CREATE).code, 'a real sha was rejected by the boundary').toBe(0)
    record(repo, 'main', sha)
  })

  it('judges the worktree the session is in, not the project directory', () => {
    // **The defect this change exists for.** `main` is recorded and `fix/other` is not, so a pass
    // here could only come from judging the wrong checkout — which is the case where a PR shipped
    // labelled reviewed because some other branch happened to have a record.
    const r = gate(CREATE, { cwd: worktree })
    expect(r.code, "the project directory's record passed a PR from another worktree").toBe(2)
    expect(r.stderr).toContain('fix__other.md')

    record(worktree, 'fix/other', git('rev-parse', 'fix/other'))
    expect(gate(CREATE, { cwd: worktree }).code, "the worktree's own record was not found").toBe(0)
    unrecord(worktree, 'fix/other')
  })

  it('looks for the record at the repo root, not beside the shell', () => {
    // A session sitting in a subdirectory resolved `.work/reviews/…` relative to itself and reported
    // a missing record the user could see was present, which reads as the gate being broken.
    expect(gate(CREATE, { cwd: join(repo, 'sub') }).code,
      'a subdirectory session false-blocked a reviewed branch').toBe(0)
  })

  it('falls back to the project directory when cwd exists but is not a work tree', () => {
    // **The trap in resolving the root.** Testing the path with `[ -d ]` passes for any directory
    // that exists — a parent holding several repos, a scratch directory — and then `--show-toplevel`
    // fails and the whole gate exits 0. Asserted with the record REMOVED, because with it present a
    // pass proves nothing about whether the fallback ran or the gate simply gave up.
    unrecord(repo, 'main')
    expect(gate(CREATE, { cwd: elsewhere }).code, 'a cwd outside any repo disabled the gate').toBe(2)
    record(repo, 'main', sha)
    expect(gate(CREATE, { cwd: elsewhere }).code, 'and it still passes a reviewed branch').toBe(0)
  })

  it('falls back from a work tree that has no commits yet', () => {
    // **The other half of the same guard.** `--show-toplevel` succeeds on a repo with no commits, so
    // asking only that question lets the resolution through, and the `|| exit 0` on the HEAD lookup
    // below then turns the gate off for the checkout the PR belongs to rather than falling back to
    // it. A scratch repo a session initialised and never committed to is enough to reach it.
    unrecord(repo, 'main')
    expect(gate(CREATE, { cwd: unborn }).code, 'an unborn work tree disabled the gate').toBe(2)
    record(repo, 'main', sha)
    expect(gate(CREATE, { cwd: unborn }).code, 'and it still passes a reviewed branch').toBe(0)
  })

  it('falls back when cwd is empty, rather than reading the hook\'s own directory', () => {
    // `git -C ""` runs against whatever directory the hook process happens to be launched in, which
    // is nobody's checkout in particular — so an empty `cwd` has to be caught before the probe, not
    // by it. The hook is launched inside `repo`, which IS recorded, while the project directory is
    // the unrecorded worktree: a pass could then only come from judging `repo`, which nothing asked
    // about.
    expect(gate(CREATE, { cwd: '', projectDir: worktree, spawnIn: repo }).code,
      "an empty cwd judged the hook's own directory").toBe(2)
    // The control, so this cannot pass on a gate that refuses every empty cwd outright: with the
    // project directory recorded, the fallback still answers yes.
    expect(gate(CREATE, { cwd: '', projectDir: repo, spawnIn: repo }).code,
      'the fallback stopped accepting a reviewed branch').toBe(0)
  })

  it('falls back when cwd does not exist at all', () => {
    unrecord(repo, 'main')
    expect(gate(CREATE, { cwd: '/nonexistent/path/for/this/test' }).code).toBe(2)
    record(repo, 'main', sha)
  })
})
