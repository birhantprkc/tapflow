#!/usr/bin/env node
// The decision half of `.claude/hooks/issue-parent-gate.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block. Kept out of the shell because the rules are parsing rules and the
// shell version got three of them wrong — see `scripts/lib/issue-parent.mjs`.
//
// **A blocked command is told which rule it broke.** This file used to print one constant for all
// three outcomes, so a body file the gate could not open was answered with the parent rule — and the
// author goes to add a line the body already has. That happened filing #700, whose body carried
// `Parent: #609` the whole time; the real fault was a relative `--body-file` resolved against the
// repo root rather than the directory the command would have run in.
import { judge } from './lib/issue-parent.mjs'

const NO_PARENT = `Blocked: this issue names no parent.

An issue split out of other work needs a line of its own in the body:

    Parent: #607

so the work it came from can enumerate what it still owes. Prose like "raised by the review of #647"
does not count — nothing can build a checklist from it, which is how nine issues from one day of
work on #607 became unreachable from #607.

If it genuinely stands alone — a reported bug, a chore, a new idea — say so instead, with a reason:

    <!-- standalone: reported by a user, not split out of anything -->

And before filing at all: a finding under ~10 lines that the lens you are already running can judge
is fixed in that PR, not deferred. AGENTS.md > "An adjacent defect is fixed here unless it needs its
own decision".`

const NO_BODY = `Blocked: no body could be read from this issue creation.

The gate reads --body, --body-file, or the heredoc or here-string behind \`--body-file -\`. It found
none of them, or found several and will not guess which one is the body.

Nothing has been decided about the Parent: line — the body was never read.`

/**
 * Names the path that was opened and why it could not be read.
 *
 * **The cause is not always the relative path**, and saying so anyway reproduces inside this fix the
 * exact defect it exists to end: a typo in an absolute path, a directory, and a permissions failure
 * were all answered with "pass an absolute path", which the author already had.
 */
const CAUSE = {
  EISDIR: 'That path is a directory.',
  EACCES: 'That path is not readable — check its permissions.',
  EPERM: 'That path is not readable — check its permissions.',
  ELOOP: 'That path is a symlink loop.',
}

function unreadableBodyFile(v) {
  const why = CAUSE[v.code]
    ?? (v.file !== v.resolved
      ? `It was written relative to the directory your command runs in, and resolved as above.`
      : `No file is there.`)
  return `Blocked: ${v.detail}

${why}

Nothing has been decided about the Parent: line — the body was never read.`
}

const PROCESS_SUBSTITUTION = `Blocked: the body is a process substitution.

\`--body-file <(…)\` hands gh a file descriptor, and its text exists only while the command runs.
The gate cannot read it without running the command, so it cannot tell whether the body names a
parent.

Write the body to a file, or pass it inline:

    --body-file body.md
    --body-file - <<< "Parent: #607"

Nothing has been decided about the Parent: line — the body was never read.`

const MESSAGES = {
  'no-parent': () => NO_PARENT,
  'no-body': () => NO_BODY,
  'unreadable-body-file': unreadableBodyFile,
  'process-substitution': () => PROCESS_SUBSTITUTION,
}

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

// Fail open on anything unparseable, matching the other gates in this directory: this guards a
// cooperative-but-forgetful agent, not an adversary, and a gate that dies noisily on a malformed
// payload would block every Bash call in the session.
let cmd
let cwd
try {
  const payload = JSON.parse(raw)
  cmd = payload?.tool_input?.command
  // **A payload with no `command` is judged on the whole payload**, which is what the prefilter in
  // the shell half already does. `?? ''` made a missing key indistinguishable from an empty command,
  // and an empty command matches nothing, so an unexpected payload shape switched the gate off in
  // silence. Reading more than was asked for costs a false block; reading nothing costs the gate.
  if (typeof cmd !== 'string' || !cmd) cmd = raw
  // The directory the command would run in. The hook itself runs from the repository root, so
  // without this a relative --body-file is looked for in the wrong tree and reported as missing.
  cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd()
} catch { process.exit(0) }
if (!cmd) process.exit(0)

let verdict
try { verdict = judge(cmd, undefined, cwd) } catch { process.exit(0) }
if (!verdict.blocked) process.exit(0)

// An unrecognised reason falls back to the parent rule rather than to silence: a new reason added
// without a message here should still block, since blocking is what the verdict said.
const message = (MESSAGES[verdict.reason] ?? MESSAGES['no-parent'])(verdict)
process.stderr.write(`${message}\n`)
// `exitCode` rather than `exit(2)`: writes to a pipe are asynchronous on Windows, and `exit`
// discards whatever is still queued — the status would block but the reason could arrive cut off.
// Nothing is pending after the stdin loop, so the process still ends here.
process.exitCode = 2
