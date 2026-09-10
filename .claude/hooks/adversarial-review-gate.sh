#!/bin/bash
# PreToolUse(Bash) gate: blocks `gh pr create` unless an adversarial review
# record exists for the current branch AND references the current HEAD commit.
# Review records live in .work/reviews/<branch>.md (local-only, gitignored with
# the rest of .work/). The HEAD-hash check guarantees "reviewed code == PR code":
# any commit after the review invalidates the record until it is refreshed.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
# A payload with no `command` key is not an empty command -- `// ""` made the two identical and the
# gate passed at exit 0. Judge the whole payload instead, the way the sibling gates do; the
# command-position rule below still applies, so an ordinary payload is unaffected.
[ -n "$cmd" ] || cmd=$input
# Match the PR-create invocation only in command position: line start, after
# ; && |, inside $( ) capture, or after then/do. A plain substring match would
# false-positive on commit messages / docs that merely mention the command.
# Backticks are deliberately NOT a command position (markdown quoting).
# Fail-open by design (jq/git missing, not a repo): this gate guards a
# cooperative-but-forgetful agent, not an adversary.
printf '%s' "$cmd" | grep -qE '(^[[:space:]]*|(;|&&|\||\$\()[[:space:]]*|(^|[[:space:]])(then|do)[[:space:]]+)gh[[:space:]]+pr[[:space:]]+create' || exit 0

# Where the session actually is, when that is a work tree; the project dir
# otherwise. This used to read the project dir unconditionally, so a session
# working in a git worktree -- the ordinary way to work while another session
# holds the main checkout -- had its PR judged against whatever that checkout
# happened to be on. Blocking is the harmless half; the other half is that a
# record for that unrelated branch, referencing its own HEAD, satisfied the gate.
#
# Asked of git rather than tested with `[ -d ]`: a path that exists and is not a
# work tree has to reach the fallback, not fail open past it. HEAD is asked for in
# the same breath, because `--show-toplevel` alone succeeds on a repo with no
# commits — and the `|| exit 0` further down would then turn the gate off for the
# checkout the PR actually belongs to, rather than falling back to it. The empty
# case is checked first: `git -C ""` runs against the hook's own directory, which
# is nobody's checkout in particular.
root=$(printf '%s' "$input" | jq -r '.cwd // ""')
[ -n "$root" ] && git -C "$root" rev-parse --show-toplevel HEAD >/dev/null 2>&1 \
  || root="${CLAUDE_PROJECT_DIR:-.}"
cd "$root" 2>/dev/null || exit 0
# The record sits at the repo root, not beside wherever the shell happens to sit.
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
head=$(git rev-parse HEAD 2>/dev/null) || exit 0
record="$top/.work/reviews/${branch//\//__}.md"

if [ ! -f "$record" ]; then
  echo "Blocked: no adversarial review record ($record). Before creating a PR, have an independent context (a fresh subagent — no extra accounts needed; Codex is optional) review the diff, then write findings and dispositions (fixed / skipped+reason) to that file, including the full 40-char HEAD hash (git rev-parse HEAD). Docs-only PR: skip the review but still write the record with the skip reason and the same full HEAD hash. If this command is not actually creating a PR (the text merely mentions the command), split that text into a separate command. See: AGENTS.md > Adversarial Review." >&2
  exit 2
fi
# Anchored on hex boundaries: unanchored, the match is satisfied by any longer
# hex string that merely contains the sha, which is not "reviewed == shipped".
if ! grep -qE "(^|[^0-9a-fA-F])$head([^0-9a-fA-F]|$)" "$record"; then
  echo "Blocked: $record does not reference the current HEAD ($head). Either commits were added after the review, or the record contains an abbreviated hash — refresh the review against the current diff and record the full 40-char hash (git rev-parse HEAD), then retry." >&2
  exit 2
fi
exit 0
