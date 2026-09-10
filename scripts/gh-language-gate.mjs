#!/usr/bin/env node
// The decision half of `.claude/hooks/gh-language-gate.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block. Kept out of the shell for the reason the file it replaces proves:
// a regex over the whole command cannot tell a `gh` call from the words that spell one.
import { judge } from './lib/gh-language.mjs'

const message = (v) => `Blocked: ${v.where} is in Korean: "${v.line}"

PR and issue titles and bodies are written in English, so a contributor of any language can read
them (AGENTS.md > "Branches, Commits & Releases"). Conversation and docs keep their own KO/EN rules,
and this gate reads only the title and body — the rest of your command is yours. A line is judged
Korean only when its Hangul outnumbers its Latin letters, so an English sentence naming a Korean
label passes.

Rewrite that line in English and re-run.`

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
  // The directory the command would run in, so a relative --body-file is read from the tree the
  // session is in rather than from wherever the hook was launched.
  cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd()
} catch { process.exit(0) }
if (!cmd) process.exit(0)

let verdict
try { verdict = judge(cmd, undefined, cwd) } catch { process.exit(0) }
if (!verdict.blocked) process.exit(0)

process.stderr.write(`${message(verdict)}\n`)
// `exitCode` rather than `exit(2)`: writes to a pipe are asynchronous on Windows, and `exit`
// discards whatever is still queued — the status would block but the reason could arrive cut off.
// Nothing is pending after the stdin loop, so the process still ends here.
process.exitCode = 2
