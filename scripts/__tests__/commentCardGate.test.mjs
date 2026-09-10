// The gate that asks for the comment card before a comment goes out under the user's account.
//
// **It is wired locally and tested here on purpose.** The wiring lives in gitignored
// `settings.local.json` so a contributor never loads it; the script is tracked so it is not the one
// gate in this repo without tests. Every other gate here turned out to have a hole that only a test
// found — a matcher blind to `Edit`, a prefilter blind to `g"h"`, a flag reader taking the first
// occurrence where pflag takes the last — and this one judges prose, which is more subtly wrong.
//
// The contributor-safety assertion below is the load-bearing one. Layers 1 and 2 are "it was not
// wired for them"; only layer 3, allowing the command outright when the card is absent, survives
// somebody wiring it by mistake.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { postsAComment, cardWasRead, judge } from '../lib/comment-card.mjs'
import { ghInvocations } from '../lib/gh-command.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const HOOK = path.join(REPO, '.claude/hooks/comment-card-gate.sh')

/** A transcript line carrying one tool call, in the shape the runtime writes. */
const record = (name, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } })
const CARD = path.resolve('/repo/.work/COMMENT-CARD.md')
const READ_CARD = record('Read', { file_path: CARD })
/** `cardWasRead` against the card this repo would resolve, which is the whole point of the second
 *  argument: a filename match accepted `/tmp/COMMENT-CARD.md` and `NOT-COMMENT-CARD.md` alike. */
const sawCard = (tx) => cardWasRead(tx, CARD)
/** A Bash record with the directory it ran in, which is what a relative mention is resolved against. */
const bashAt = (cwd, command) => JSON.stringify({ cwd, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })

describe('which commands post a comment', () => {
  const POSTS = {
    'a PR comment': 'gh pr comment 701 --body "x"',
    'an issue comment': 'gh issue comment 700 --body "x"',
    'a review with a body': 'gh pr review 701 --comment --body "x"',
    'an inline reply through the API': 'gh api repos/o/r/pulls/701/comments/1/replies -F body=@r.md',
    'a body behind an attached shorthand': 'gh api repos/o/r/issues/1/comments -fbody=hi',
    'behind a separator': 'git status && gh pr comment 701 --body "x"',
    'with the command word broken by quotes': 'g"h" pr comment 701 --body "x"',
    'a GraphQL mutation': "gh api graphql -f query='mutation{addComment(input:{subjectId:\"X\",body:\"hi\"}){clientMutationId}}'",
  }
  for (const [name, cmd] of Object.entries(POSTS)) {
    it(`sees ${name}`, () => {
      expect(postsAComment(cmd)).toBe(true)
    })
  }

  const DOES_NOT = {
    'reading comments': 'gh api repos/o/r/pulls/701/comments --jq ".[].body"',
    'listing them': 'gh pr view 701 --json comments',
    'creating a PR': 'gh pr create --title x --body-file b.md',
    'creating an issue': 'gh issue create --title x --body "Parent: #607"',
    'the words inside a script string': 'node -e "console.log(\'gh pr comment\')"',
    'the words in a heredoc payload': 'cat > plan.md <<EOF\nrun gh pr comment when ready\nEOF',
  }
  for (const [name, cmd] of Object.entries(DOES_NOT)) {
    it(`ignores ${name}`, () => {
      expect(postsAComment(cmd)).toBe(false)
    })
  }

  it('needs something after `gh api` to be an invocation at all', () => {
    // `gh api` takes a path where the other nouns take a verb, so this consumer asks the parser for
    // "any third token". Any has to mean one that is there — otherwise a bare `gh api`, or a `gh api`
    // ending a command, reads as a call with no arguments.
    expect(ghInvocations('gh api repos/o/r/pulls/1/comments', 'api', null)).toHaveLength(1)
    expect(ghInvocations('gh api', 'api', null)).toHaveLength(0)
    expect(ghInvocations('echo x && gh api', 'api', null)).toHaveLength(0)
  })

  it('separates reading an API path from writing to it', () => {
    // `gh api …/comments` is how the thread is read, and reading it is the *first* step the card
    // asks for. A gate that blocked that would block its own remedy. Each read below is a form
    // `gh api --help` documents, and the first two were blocked before review.
    for (const c of [
      'gh api repos/o/r/pulls/1/comments',
      'gh api --method GET repos/o/r/issues/1/comments -f per_page=100',
      'gh api -X GET repos/o/r/issues/1/comments -f per_page=100',
      'gh api repos/o/r/issues/1/comments --paginate',
      'gh api repos/o/r/issues/1/comments --jq ".[].body"',
    ]) expect(postsAComment(c), c).toBe(false)
  })

  describe('a GraphQL mutation is identified by its contents, not its path', () => {
    // Every other form the gate knows names what it acts on in the URL. Here the path is the
    // constant `graphql` and the operation is a string passed as a field value, so the endpoint
    // check is the cheap half and the mutation name is the decision.
    const mutation = (op) => `gh api graphql -f query='mutation{${op}(input:{}){clientMutationId}}'`

    // The list is GitHub's rather than ours, which is why it is enumerated: a `*Comment*` pattern
    // would catch `deleteIssueComment`, which publishes nothing, and miss `addPullRequestReview`,
    // which does.
    for (const op of ['addComment', 'addPullRequestReview', 'addPullRequestReviewComment',
      'addDiscussionComment', 'updateIssueComment']) {
      it(`sees ${op}`, () => expect(postsAComment(mutation(op)), op).toBe(true))
    }

    it('allows a query that only reads', () => {
      // The same distinction `--method GET` draws on the REST path: it publishes nothing.
      expect(postsAComment("gh api graphql -f query='query{viewer{login}}'")).toBe(false)
    })

    it('sees the full-URL spelling of the endpoint', () => {
      // gh routes any endpoint containing `://` verbatim, so this reaches the same place — and it is
      // the spelling a docs page hands you. The check was exact string equality; every other
      // endpoint rule in this file was already a substring regex.
      expect(postsAComment(`gh api https://api.github.com/graphql ${"-f query='mutation{addComment(input:{}){id}}'"}`)).toBe(true)
    })

    it('sees the query behind an attached shorthand', () => {
      // pflag takes `-Fquery=…` as well as `-F query=…`.
      expect(postsAComment("gh api graphql -Fquery='mutation{addComment(input:{}){id}}'")).toBe(true)
    })

    it('allows a mutation that publishes no prose', () => {
      expect(postsAComment(mutation('addLabelsToLabelable'))).toBe(false)
      expect(postsAComment(mutation('deleteIssueComment'))).toBe(false)
    })

    it('reads a query written to a file', () => {
      // The same question `--input` raised on the REST path, answered the same way: a query long
      // enough to be written to a file is the one someone took care over.
      const dir = mkdtempSync(path.join(tmpdir(), 'graphql-'))
      const file = path.join(dir, 'q.graphql')
      writeFileSync(file, 'mutation { addComment(input: {body: "hi"}) { clientMutationId } }')
      try {
        expect(postsAComment(`gh api graphql -F query=@${file}`, { cwd: dir })).toBe(true)
        expect(postsAComment(`gh api graphql --input ${file}`, { cwd: dir })).toBe(true)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    it('reads a query fed through stdin', () => {
      const cmd = "gh api graphql -F query=@- <<'EOF'\nmutation { addComment(input: {}) { id } }\nEOF"
      expect(postsAComment(cmd)).toBe(true)
    })

    it('allows a file it cannot read rather than blocking on it', () => {
      // This gate allows what it cannot judge — the posture every other rule here takes.
      expect(postsAComment('gh api graphql -F query=@/nonexistent/q.graphql')).toBe(false)
    })

    it('does not fire on the words in prose', () => {
      expect(postsAComment('echo "gh api graphql addComment"')).toBe(false)
      expect(postsAComment('cat > n.md <<EOF\ngh api graphql -f query=mutation{addComment}\nEOF')).toBe(false)
    })

    // The prefilter half is asserted where the hook is spawned against a throwaway checkout — see
    // `the hook itself, spawned`. It cannot be done from here: this repo's own card lives under
    // gitignored `.work/`, so a test that spawns the hook against this checkout passes on the
    // author's machine and allows the command in CI, where the card does not exist.
  })

  it('sees a body that arrives without a field flag', () => {
    // `--input` carries the whole request body, which is the natural form once a reply has been
    // written to a file — and reading only field flags missed it completely.
    for (const c of [
      'gh api --method POST repos/o/r/issues/1/comments --input b.json',
      'gh api -X POST repos/o/r/pulls/1/comments/1/replies --input b.json',
      'gh api --method=PATCH repos/o/r/issues/comments/1 -f body=x',
    ]) expect(postsAComment(c), c).toBe(true)
  })

  it('sees a closing or reopening comment', () => {
    // All four of `gh {pr,issue} {close,reopen}` take `-c/--comment` and leave one, verified against
    // the binary. Only with the flag: closing something silently publishes nothing.
    for (const c of ['gh pr close 1 --comment "done"', 'gh issue close 1 -c "done"', 'gh pr reopen 1 --comment=x']) {
      expect(postsAComment(c), c).toBe(true)
    }
    expect(postsAComment('gh pr close 1 --delete-branch')).toBe(false)
  })

  it('sees a review created through the API', () => {
    // `POST /repos/{o}/{r}/pulls/{n}/reviews` with a body is the API form of `gh pr review --body`.
    expect(postsAComment('gh api --method POST repos/o/r/pulls/1/reviews -f body=x')).toBe(true)
  })

  it('reads the endpoint by position, not by scanning every token', () => {
    // A quoted field stays one token, so scanning for a comments-shaped path picked the *value* and
    // blocked a command that creates an issue.
    expect(postsAComment("gh api repos/o/r/issues -f 'body=See /comments/123'")).toBe(false)
  })

  it('sees --input with no method, which gh sends as a POST', () => {
    // The form where `--input` is the only signal there is: supplying a body makes `POST` the
    // default, so nothing on the line says so. With an explicit `--method POST` the method carries
    // it and this guard cannot be seen to matter.
    expect(postsAComment('gh api repos/o/r/issues/1/comments --input b.json')).toBe(true)
  })

  it('does not treat a GET as a write even when a body rides along', () => {
    // The one combination where the method guard decides. Everywhere else the body-field rule
    // already answers, which is why removing this guard leaves the rest of the suite green.
    expect(postsAComment('gh api --method GET repos/o/r/issues/1/comments --input q.json')).toBe(false)
    expect(postsAComment('gh api --method GET repos/o/r/issues/1/comments -f body=x')).toBe(false)
  })
})

describe('whether the card was read this session', () => {
  const withTranscript = (lines, fn) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'card-'))
    const tx = path.join(dir, 't.jsonl')
    writeFileSync(tx, lines.join('\n') + '\n')
    try { return fn(tx) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('is true after a Read of it', () => {
    expect(withTranscript([READ_CARD], sawCard)).toBe(true)
  })

  it('is false when the name only appears in prose', () => {
    // A gate satisfied by its own block message would never fire twice.
    const mention = JSON.stringify({ message: { content: [{ type: 'text', text: 'read .work/COMMENT-CARD.md first' }] } })
    expect(withTranscript([mention], sawCard)).toBe(false)
  })

  it('is false for a card that is not this repository\'s', () => {
    // A filename match took any of these. The gate resolves a path; the check now compares it.
    for (const fp of ['/tmp/COMMENT-CARD.md', '/other/repo/.work/COMMENT-CARD.md', '/repo/.work/NOT-COMMENT-CARD.md']) {
      expect(withTranscript([record('Read', { file_path: fp })], sawCard), fp).toBe(false)
    }
  })

  it('resolves a relative shell mention against the directory it ran in', () => {
    // `cat .work/COMMENT-CARD.md` counted the same from anywhere, so a command that failed — or ran
    // in a different checkout — satisfied the gate. Every transcript record carries the `cwd` the
    // call ran in; this project's carry 22 distinct ones, so the wrong-directory case is the common
    // one rather than a corner.
    const repo = path.dirname(path.dirname(CARD))
    expect(withTranscript([bashAt(repo, 'cat .work/COMMENT-CARD.md')], sawCard), 'at the root').toBe(true)
    expect(withTranscript([bashAt(path.join(repo, 'packages/relay'), 'cat .work/COMMENT-CARD.md')], sawCard),
      'in a subdirectory, where it fails').toBe(false)
    expect(withTranscript([bashAt('/somewhere/else', 'cat .work/COMMENT-CARD.md')], sawCard),
      'in another checkout').toBe(false)
  })

  it('takes an absolute mention with no directory to resolve against', () => {
    const noCwd = JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `cat ${CARD}` } }] } })
    expect(withTranscript([noCwd], sawCard)).toBe(true)
    const relativeNoCwd = JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat .work/COMMENT-CARD.md' } }] } })
    expect(withTranscript([relativeNoCwd], sawCard), 'a relative one has nothing to resolve with').toBe(false)
  })

  it('is false when another file was read', () => {
    expect(withTranscript([record('Read', { file_path: '/repo/AGENTS.md' })], sawCard)).toBe(false)
  })

  it('counts an @path attachment, which is not a tool call at all', () => {
    // The most direct way the content arrives, and it carries no `message`: 64 such records in this
    // project's transcripts. Reading only `message.content` blocked the person who had just
    // supplied the card.
    const attached = JSON.stringify({
      type: 'user',
      attachment: { type: 'file', filename: CARD, content: { type: 'text', file: { filePath: CARD, content: '# card' } } },
      message: null,
    })
    expect(withTranscript([attached], sawCard)).toBe(true)
  })

  it('does not count an attachment of some other file', () => {
    const other = JSON.stringify({ type: 'user', attachment: { type: 'file', filename: '/repo/AGENTS.md' }, message: null })
    expect(withTranscript([other], sawCard)).toBe(false)
  })

  it('counts the other ways the content reaches the context', () => {
    // Narrowing to `Read` excluded all three of these for no reason: authoring the card, editing it,
    // and reading it through the shell all put it in front of the writer.
    expect(withTranscript([record('Write', { file_path: CARD, content: '#' })], sawCard)).toBe(true)
    expect(withTranscript([record('Edit', { replace_all: false, file_path: CARD })], sawCard)).toBe(true)
    expect(withTranscript([bashAt(path.dirname(path.dirname(CARD)), 'cat .work/COMMENT-CARD.md')], sawCard)).toBe(true)
  })

  it('survives an unparseable line', () => {
    expect(withTranscript(['not json at all', READ_CARD], sawCard)).toBe(true)
  })

  it('is false when the transcript cannot be read', () => {
    expect(cardWasRead('/nowhere/at/all.jsonl', CARD)).toBe(false)
  })
})

describe('a contributor is unaffected even if this is wired for them', () => {
  it('allows the command outright when the card is absent', () => {
    // **Layer 3, and the only one that survives a mistake.** The card lives under gitignored
    // `.work/` and the wiring under gitignored `settings.local.json`, so a contributor does not
    // reach this — but neither of those is a property of the code.
    const v = judge('gh pr comment 1 --body "x"', {
      cardPath: '/repo/.work/COMMENT-CARD.md',
      transcriptPath: '/nowhere.jsonl',
      exists: () => false,
    })
    expect(v.blocked).toBe(false)
  })

  it('blocks the same command when the card is there and unread', () => {
    // The contrast is what makes the assertion above mean something: without it, "allows" could be
    // true for any reason at all.
    const v = judge('gh pr comment 1 --body "x"', {
      cardPath: '/repo/.work/COMMENT-CARD.md',
      transcriptPath: '/nowhere.jsonl',
      exists: () => true,
    })
    expect(v).toMatchObject({ blocked: true, reason: 'card-not-read' })
  })
})

describe('the hook itself, spawned', () => {
  const readSource = (f) => readFileSync(path.join(REPO, 'scripts', f), 'utf8')

  /** A throwaway checkout carrying a card, so the hook resolves a root the way it will in use. */
  /** `transcript` may be a function of the throwaway repo's path, since the card's resolved location
   *  is now what the check compares against. */
  const inRepo = (cmd, { card = true, transcript = [], from = '.' } = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'card-repo-'))
    spawnSync('git', ['init', '-q', dir])
    if (card) {
      mkdirSync(path.join(dir, '.work'), { recursive: true })
      writeFileSync(path.join(dir, '.work/COMMENT-CARD.md'), '# card\n')
    }
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true })
    for (const f of ['comment-card-gate.mjs', 'lib/comment-card.mjs', 'lib/gh-command.mjs']) {
      writeFileSync(path.join(dir, 'scripts', f), readSource(f))
    }
    const tx = path.join(dir, 't.jsonl')
    const lines = typeof transcript === 'function' ? transcript(dir) : transcript
    writeFileSync(tx, lines.join('\n') + '\n')
    mkdirSync(path.join(dir, from), { recursive: true })
    try {
      return spawnSync('bash', [HOOK], {
        input: JSON.stringify({ tool_input: { command: cmd }, cwd: path.join(dir, from), transcript_path: tx }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('does not accept a read of some other repository\'s card', () => {
    // The fixture that used to pass this suite: a `Read` of `/repo/.work/COMMENT-CARD.md` while the
    // card actually lives in the throwaway checkout. Matching by filename accepted it.
    expect(inRepo('gh pr comment 701 --body "x"', { transcript: [READ_CARD] }).status).toBe(2)
  })

  it('blocks a comment when the card has not been read', () => {
    const r = inRepo('gh pr comment 701 --body "x"')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/COMMENT-CARD\.md/)
  })

  it('allows it once the card has been read', () => {
    const readItThere = (dir) => [record('Read', { file_path: path.join(dir, '.work/COMMENT-CARD.md') })]
    expect(inRepo('gh pr comment 701 --body "x"', { transcript: readItThere }).status).toBe(0)
  })

  it('allows it in a checkout with no card', () => {
    expect(inRepo('gh pr comment 701 --body "x"', { card: false }).status).toBe(0)
  })

  it('blocks a spelling the raw text does not contain', () => {
    // The prefilter matches what the shell would leave, the way the sibling gates do. Without the
    // squash, `g"h" pr comment` is a real invocation the hook never looks at.
    expect(inRepo('g"h" pr comment 701 --body "x"').status).toBe(2)
  })

  it('finds the card from a subdirectory, which is where a session usually is', () => {
    // `payload.cwd` is the session's working directory, not the repo root — 26 distinct values in
    // this project's transcripts and exactly one of them the root. Resolving the card against it
    // looked equivalent and silently turned the gate off for the rest of any session that had
    // `cd`-ed anywhere.
    expect(inRepo('gh pr comment 701 --body "x"', { from: 'packages/relay' }).status).toBe(2)
  })

  it('fails open when the payload carries no transcript', () => {
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command: 'gh pr comment 1 --body x' }, cwd: REPO }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status, 'every other missing field lets the command through').toBe(0)
  })

  it('allows an unrelated command without paying for node', () => {
    expect(inRepo('git status --short').status).toBe(0)
  })

  it('the prefilter lets a GraphQL mutation reach the parser', () => {
    // **Both halves missed it at once.** The path matcher looks for a `/comments` segment and the
    // path here is `graphql`; the shell prefilter matches `*gh*comment*` in lowercase while the
    // mutation is spelled `addComment`, so node was never spawned and the parser never got a chance.
    // Asserted through the hook because the prefilter is the half a unit test cannot see.
    //
    // In a throwaway checkout, not this one: the card the gate needs lives under gitignored
    // `.work/`, so spawning against this repo passes locally and allows the command in CI.
    expect(inRepo("gh api graphql -f query='mutation{addComment(input:{}){id}}'").status).toBe(2)
  })

  it('the prefilter still ignores a command that is neither', () => {
    // `*gh*api*graphql*` was added as one more literal arm rather than making the filter
    // case-insensitive, because that would widen what pays for a node process on every Bash call.
    expect(inRepo('gh api graphql -f query="query{viewer{login}}"').status).toBe(0)
  })

  it('fails open on a payload it cannot parse', () => {
    const r = spawnSync('bash', [HOOK], {
      input: 'not json, gh pr comment',
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status, 'a broken gate would block every Bash call in the session').toBe(0)
  })
})
