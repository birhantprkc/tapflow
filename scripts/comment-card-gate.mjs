#!/usr/bin/env node
// The decision half of `.claude/hooks/comment-card-gate.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block.
//
// **PreToolUse, not Stop.** The sibling prose gate runs at Stop, which is right for a file — you can
// still edit it. A comment is public the moment the command runs, so the only stage where a check
// can change anything is before it.
import path from 'node:path'
import { judge } from './lib/comment-card.mjs'

const CARD = '.work/COMMENT-CARD.md'

const message = `Blocked: read ${CARD} before writing this comment.

It is one page, and it is there because a comment written from scratch each time reads like a
different person. The rules it carries are the ones your own edits produced — name the comment's
job, say only what is new since your last comment on this thread, and file a finding with no action
for this reader as an issue instead.

Read it, then run this command again.`

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

// Fail open on anything unparseable, matching every other gate in this directory: these guard a
// cooperative-but-forgetful agent, and a gate that dies would block every Bash call in the session.
let payload
try { payload = JSON.parse(raw) } catch { process.exit(0) }

// **A payload with no `command` is judged on the whole payload**, which is what the prefilter in the
// shell half already does. `?? ''` made a missing key indistinguishable from an empty command, and an
// empty command matches nothing, so an unexpected payload shape switched the gate off in silence.
// Reading more than was asked for costs a false block; reading nothing costs the gate.
let cmd = payload?.tool_input?.command
if (typeof cmd !== 'string' || !cmd) cmd = raw
if (!cmd) process.exit(0)

// Fail open here too. Every other missing field lets the command through; a missing transcript is
// the one that used to block, which is the wrong direction for a gate whose whole posture is that
// it guards a cooperative reader.
const transcript = payload?.transcript_path
if (typeof transcript !== 'string' || !transcript) process.exit(0)

// **The shell already resolved the root and `cd`-ed there**, so this is it. Re-deriving it from
// `payload.cwd` looked equivalent and was not: that field is the session's working directory, which
// is a subdirectory for most of a session's life — 26 distinct values in this project's transcripts,
// exactly one of them the repo root. The gate then looked for the card under `packages/relay/.work/`,
// found nothing, and allowed the command for the same reason a contributor's checkout allows it.
const root = process.cwd()

let verdict
try {
  verdict = judge(cmd, {
    // **Two different directories, deliberately.** The card is found from the repo root above; a
    // `@file` inside a GraphQL field is resolved against the directory the command would run in,
    // which is what `payload.cwd` is and what the issue-parent gate reads it for.
    cwd: typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : root,
    cardPath: path.join(root, CARD),
    transcriptPath: transcript,
  })
} catch { process.exit(0) }

if (!verdict.blocked) process.exit(0)
process.stderr.write(`${message}\n`)
// `exitCode` rather than `exit(2)`: writes to a pipe are asynchronous on Windows, and `exit`
// discards whatever is still queued — the status would block but the reason could arrive cut off.
// Nothing is pending after the stdin loop, so the process still ends here.
process.exitCode = 2
