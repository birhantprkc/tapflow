// The gate that leaves merging and approving to the user, on every road that reaches them.
//
// **This file exists because the gate had none, and the gap that hid was the ordinary one.** The
// shell matcher recognises command position as line-start / `;` / `&&` / `|` / `$(` / `then` / `do`,
// which is not what bash means by it: an assignment prefix, `env`, `sudo`, `command`, `xargs`, an
// `if` condition and a background `&` all passed at exit 0 while the bare form was blocked. The
// parser in this package had every one of those already. The wrapper cases below are the ones a
// forgetful agent actually types, so they are asserted through the whole hook rather than only
// against `judge`.
//
// The `gh pr merge` strings are assembled rather than written out: the shell half has no notion of a
// heredoc or a string literal, so a literal in this file is a command position as far as it is
// concerned, and it blocks the test that tests it.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { judge } from '../lib/pr-merge.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const HOOK = path.join(REPO, '.claude/hooks/pr-merge-guard.sh')

const run = (command) =>
  spawnSync('bash', [HOOK], { input: JSON.stringify({ tool_input: { command }, cwd: REPO }), encoding: 'utf8', cwd: REPO })

const PR_MERGE = ['gh', 'pr', 'merge'].join(' ')
const PR_REVIEW = ['gh', 'pr', 'review'].join(' ')

describe('the gh pr forms, however they are prefixed', () => {
  // Each of these ran the action and passed the gate before the parser was wired in. They are the
  // reason the decision moved out of the shell matcher.
  const WRAPPED = {
    'bare': `${PR_MERGE} 1`,
    'an assignment prefix': `GH_REPO=o/r ${PR_MERGE} 1`,
    'env': `env ${PR_MERGE} 1`,
    'sudo': `sudo ${PR_MERGE} 1`,
    'command': `command ${PR_MERGE} 1`,
    'xargs': `echo 1 | xargs ${PR_MERGE}`,
    'an if condition': `if ${PR_MERGE} 1; then echo ok; fi`,
    'a background &': `sleep 0 & ${PR_MERGE} 1`,
    'review, wrapped': `env ${PR_REVIEW} 1 --approve`,
  }
  for (const [what, cmd] of Object.entries(WRAPPED)) {
    it(`blocks ${what}`, () => expect(run(cmd).status, cmd).toBe(2))
  }

  it('still ignores the words in prose', () => {
    // The parser strips heredoc payloads and respects quoting, which the shell matcher does not.
    // `judge` is asserted directly here: the shell half runs first and refuses these, which is a
    // known false block rather than a decision this file is testing.
    expect(judge(`echo "${PR_MERGE} 1"`).blocked).toBe(false)
    expect(judge(`cat > n.md <<EOF\n${PR_MERGE} 1\nEOF`).blocked).toBe(false)
  })
})

describe('gh api reaches the same two actions', () => {
  const BLOCKED = {
    'a merge by PUT': 'gh api --method PUT repos/o/r/pulls/1/merge -f merge_method=squash',
    'a merge by -X': 'gh api -X PUT repos/o/r/pulls/1/merge',
    // pflag takes the value attached to a shorthand, verified against the binary: `gh api -XGET
    // rate_limit` succeeds. Reading only the spaced and `=` spellings inferred GET and let a merge
    // through — the single most ordinary way someone with curl habits types it.
    'a merge by attached -Xput': 'gh api -Xput repos/o/r/pulls/1/merge',
    'a merge by -XPUT': 'gh api -XPUT repos/o/r/pulls/1/merge',
    // gh sends any endpoint containing `://` verbatim, so the URL a docs page hands you reaches the
    // same endpoint.
    'a merge by full URL': 'gh api --method PUT https://api.github.com/repos/o/r/pulls/1/merge',
    'an approval': 'gh api -X POST repos/o/r/pulls/1/reviews -f event=APPROVE',
    'a review with no event': 'gh api -X POST repos/o/r/pulls/1/reviews -f body=x',
    'submitting a pending review': 'gh api -X POST repos/o/r/pulls/1/reviews/9/events -f event=APPROVE',
    // With no method given, gh sends POST when a field is present.
    'a write with the method implied': 'gh api repos/o/r/pulls/1/reviews -f event=APPROVE',
    'the same with an attached field': 'gh api repos/o/r/pulls/1/reviews -fevent=APPROVE',
    'behind a separator': 'git status && gh api --method PUT repos/o/r/pulls/1/merge',
    'with the command word broken by quotes': 'g"h" api --method PUT repos/o/r/pulls/1/merge',
    // pflag overwrites a scalar flag given twice, so the last one is the method that is sent.
    'a method overridden later on the line': 'gh api --method GET --method PUT repos/o/r/pulls/1/merge',
  }
  for (const [what, cmd] of Object.entries(BLOCKED)) {
    it(`blocks ${what}`, () => expect(judge(cmd).blocked, cmd).toBe(true))
  }

  const ALLOWED = {
    'asking whether a PR is merged': 'gh api --method GET repos/o/r/pulls/1/merge',
    'listing reviews': 'gh api repos/o/r/pulls/1/reviews',
    'a HEAD request': 'gh api --method HEAD repos/o/r/pulls/1/merge',
    'a comment': 'gh api repos/o/r/pulls/1/comments -f body=hi',
    'an unrelated endpoint': 'gh api repos/o/r/issues -f title=x',
    'prose that mentions the endpoint': 'echo "gh api --method PUT repos/o/r/pulls/1/merge"',
    'a branch merge': 'gh api --method POST repos/o/r/merges -f base=main',
  }
  for (const [what, cmd] of Object.entries(ALLOWED)) {
    it(`allows ${what}`, () => expect(judge(cmd).blocked, cmd).toBe(false))
  }
})

describe('the GraphQL mutations that merge or approve', () => {
  // **The team gate had none of these, and the only thing objecting was a personal gate.**
  // `comment-card-gate.sh` is wired in gitignored `settings.local.json`, so it is absent for anyone
  // else — and it objects because its card is unread, which stops applying the moment the card is
  // read. Nothing in `.claude/settings.json` refused `mergePullRequest` at all.
  const mutation = (op) => `gh api graphql -f query='mutation{${op}(input:{}){clientMutationId}}'`

  for (const op of ['mergePullRequest', 'enablePullRequestAutoMerge']) {
    it(`blocks ${op} as a merge`, () => expect(judge(mutation(op)).reason, op).toBe('merge'))
  }
  for (const op of ['addPullRequestReview', 'submitPullRequestReview']) {
    it(`blocks ${op} as a review`, () => expect(judge(mutation(op)).reason, op).toBe('review'))
  }

  it('blocks the full-URL spelling', () => {
    expect(judge("gh api https://api.github.com/graphql -f query='mutation{mergePullRequest(input:{}){x}}'").blocked).toBe(true)
  })

  it('blocks a document written to a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gql-'))
    const file = path.join(dir, 'm.graphql')
    writeFileSync(file, 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }')
    try {
      expect(judge(`gh api graphql -F query=@${file}`, dir).blocked).toBe(true)
      expect(judge(`gh api graphql --input ${file}`, dir).blocked).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('survives an alias and a variable-based document', () => {
    expect(judge("gh api graphql -f query='mutation{ m: mergePullRequest(input:{}){x} }'").blocked).toBe(true)
    expect(judge("gh api graphql -f query='mutation($i: MergePullRequestInput!){ mergePullRequest(input: $i){x} }'").blocked).toBe(true)
  })

  it('allows a query that only reads, and a mutation that does neither', () => {
    expect(judge("gh api graphql -f query='query{repository(owner:\"o\",name:\"r\"){pullRequest(number:1){mergeable}}}'").blocked).toBe(false)
    expect(judge("gh api graphql -f query='mutation{addComment(input:{}){id}}'").blocked).toBe(false)
  })

  it('allows a document it cannot read rather than blocking on it', () => {
    expect(judge('gh api graphql -F query=@/nonexistent/m.graphql').blocked).toBe(false)
  })
})

describe('the hook as a whole', () => {
  it('names which of the two it refused', () => {
    const r = run('gh api --method PUT repos/o/r/pulls/1/merge')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/merging a PR/)
  })

  it('leaves everything else alone', () => {
    for (const cmd of ['git status', 'gh pr create -t x', 'gh api repos/o/r/pulls/1']) {
      expect(run(cmd).status, cmd).toBe(0)
    }
  })

  it('costs no node process for a command that is neither gh api nor gh pr', () => {
    // The prefilter is why this gate is cheap on every Bash call in a session.
    const r = run('ls -la')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })
})
