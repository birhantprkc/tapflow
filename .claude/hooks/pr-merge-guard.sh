#!/bin/bash
# PreToolUse(Bash) gate: blocks `gh pr merge` / `gh pr review`, because merging
# and approving are the user's to do (AGENTS.md > Core Principles).
#
# This lived inline in .claude/settings.json until it was found inert: it piped
# the payload through `echo "$input"`, which expands backslash escapes, so jq
# never parsed a command containing \n or \" and the grep decided on an empty
# string. Measured across 150 sessions: 2191 parse failures against 1 success —
# every multi-line command passed unguarded. Reading stdin with printf is the fix.
#
# The grep below matches the invocation only in command position: line start,
# after ; && |, inside $( ) capture, or after then/do. A plain substring match
# would false-positive on commit messages / docs that merely mention the
# command — and this repo's own docs discuss `gh pr merge` by name.
# Backticks are deliberately NOT a command position (markdown quoting).
#
# **That list of positions is not what bash means by command position**, which
# is why the decision now lives in scripts/pr-merge-guard.mjs and this grep is
# a backstop for when node cannot run. See the note above it, below.
#
# Fail-open by design (jq missing, unparseable payload), matching
# adversarial-review-gate.sh: this gate guards a cooperative-but-forgetful
# agent, not an adversary. Fail-closed here would block every Bash call in the
# session on a missing jq, and the 2191 failures above are the calibration for
# how long such a break can go unnoticed.
#
# Covered by the parsing half: the `gh api` REST endpoints and the GraphQL
# mutations that merge or approve. Still not covered: git plumbing.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""') || exit 0
# **A payload with no `command` key is not an empty command.** `// ""` made the two identical, every
# pattern below then failed, and the gate passed at exit 0 -- verified: `{"tool_input":{}}` allowed.
# Falling back to the whole payload keeps the gate deciding, which is what the language and
# issue-parent prefilters already do. The command-position rule still applies to it, so this catches
# less than a substring scan would and costs no new false blocks on ordinary payloads.
[ -n "$cmd" ] || cmd=$input

# Join backslash-newline continuations before matching. grep decides line by
# line, so `gh \` / `pr \` / `merge` on three physical lines reads as three
# non-matching lines while bash executes it as one `gh pr merge`. Verified: the
# unjoined form passed the matcher at exit 0.
#
# Delete the pair, substituting NOTHING — bash inserts no space, and the pair
# can split a word. Substituting a space was wrong in both directions, measured:
#   g\<nl>h pr merge  -> bash runs `gh pr merge`; a space gives `g h pr merge`,
#                        which does not match — a live bypass.
#   gh\<nl>pr merge   -> bash runs `ghpr merge`, not gh at all; a space gives
#                        `gh pr merge`, which blocks a command that is not one.
# Indentation after the newline is likewise kept, because bash keeps it: it
# stays as the whitespace separating the next word, which `[[:space:]]+` covers.
#
# A backslash-newline inside single quotes is literal, not a continuation, so
# joining can in principle over-match quoted prose. That direction is the safe
# one, and the block message says to split such text into its own command.
cmd=$(printf '%s' "$cmd" | perl -0777 -pe 's/\\\r?\n//g') || exit 0

if printf '%s' "$cmd" | grep -qE '(^[[:space:]]*|(;|&&|\||\$\()[[:space:]]*|(^|[[:space:]])(then|do)[[:space:]]+)gh[[:space:]]+pr[[:space:]]+(merge|review)'; then
  echo "Blocked: creating the PR is yours to do; merging and approving are the user's — leave them, even with --admin (AGENTS.md > Core Principles). If this command is not actually merging or approving (the text merely mentions the command), split that text into a separate command." >&2
  exit 2
fi

# Everything the grep above cannot judge, which turned out to be most of it. Two classes:
#
#   - the `gh api` forms, where the same path is a read or a write depending on the method;
#   - the ordinary prefixes and wrappers, which the grep's notion of command position misses.
#     Measured against this file before the parser was wired in: an assignment prefix, `env`,
#     `sudo`, `command`, `xargs`, `if ...; then` and a background `&` all passed at exit 0 while
#     the bare form was blocked.
#
# So the grep above is a backstop for when node cannot run, and the decision is
# `scripts/pr-merge-guard.mjs`, where it is tested. What follows is a prefilter over whether to
# pay for a node process.
squashed=${cmd//[\"\']/}
squashed=${squashed//\\/}

case "$squashed" in
  *gh*api*|*gh*pr*) ;;
  *) exit 0 ;;
esac

# The session's own checkout, the way `adversarial-review-gate.sh` resolves it (#699):
# `CLAUDE_PROJECT_DIR` alone turns the gate off for a session in a worktree, which finds no
# `scripts/` there.
root=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)
if [ -n "$root" ] && top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null); then
  root=$top
else
  root="${CLAUDE_PROJECT_DIR:-.}"
fi
cd "$root" 2>/dev/null || exit 0

[ -f scripts/pr-merge-guard.mjs ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# **Only status 2 is a verdict.** node's own failures are not — a missing binary exits 127, an
# import error exits 1 — and propagating those made every matching command in the session report a
# hook error while blocking nothing, which is the opposite of the fail-open promise above.
printf '%s' "$input" | node scripts/pr-merge-guard.mjs
status=$?
[ "$status" -eq 2 ] && exit 2
exit 0
