#!/bin/bash
# PreToolUse(Bash) gate: an issue split out of other work has to name what it came from.
#
# **The problem this exists for is measured, not hypothetical.** One day of work on #607 produced
# nine issues, and not one of them was reachable *from* #607 — every review finding graded `later`
# became a sibling nobody could enumerate. Asked "is #607 finished?", the honest answer was that
# nobody could tell, because the feature's remaining surface existed only as nine unlinked rows in a
# tracker sorted by date. Two of those nine were closed minutes later as things that should never
# have been filed.
#
# Prose mentions are not the fix and were already there: most of those nine said "raised by the
# review of #647" somewhere in the body. GitHub builds no tree from that, and neither can a script.
# A `Parent:` line is greppable, so the parent's checklist can be regenerated instead of maintained
# by memory.
#
# **It matches what the shell would leave, not what was typed.** The prefilter reads raw text while
# the parser reads a tokenized command, so `g"h" issue create` -- a real invocation -- was not in the
# raw text and the gate exited before the parser ever saw it. Removing the quotes and backslashes the
# shell removes closes that for nothing, because squashing only ever *widens* what reaches the
# parser, and the parser is the half that decides. It remains a prefilter rather than a decision:
# `$VAR` and `$(...)` are unresolved here, as they are there.
#
# **This file is only the prefilter.** Deciding needs the command tokenized and the body parsed, and
# the version that tried both in shell got three rules wrong at once — `gh issue new` walked through,
# so did an environment assignment before `gh`, `-F "issue body.md"` read a file called `issue`, and
# a `--title` could satisfy a rule about bodies. The decision is in `scripts/issue-parent-gate.mjs`,
# where it is tested. Node is spawned only for a command that mentions both words, which is rare.

# The prefilter reads the command rather than the whole payload: the JSON carries `cwd`, so a repo
# path could supply words the command never had. And the root comes from the session's own checkout,
# the way `adversarial-review-gate.sh` resolves it (#699) -- `CLAUDE_PROJECT_DIR` alone turns the
# gate off for a session in a worktree, which finds no `scripts/` there. Falling back to the raw
# input, and to the project dir, keeps the gate on rather than silently off.
input=$(cat)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$cmd" ] || cmd=$input


# The characters the shell strips on the way to a command word. Two substitutions rather than one
# bracket expression: a backslash inside one is its own argument about quoting, and this has to be
# read correctly by whoever edits it next.
squashed=${cmd//[\"\']/}
squashed=${squashed//\\/}

case "$squashed" in
  *gh*issue*) ;;
  *) exit 0 ;;
esac

root=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)
if [ -n "$root" ] && top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null); then
  root=$top
else
  root="${CLAUDE_PROJECT_DIR:-.}"
fi
cd "$root" 2>/dev/null || exit 0

[ -f scripts/issue-parent-gate.mjs ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# **Only status 2 is a verdict.** node's own failures are not — a missing binary exits 127, an
# import error exits 1 — and propagating those made every matching command in the session report a
# hook error while blocking nothing, which is the opposite of the fail-open promise above.
printf '%s' "$input" | node scripts/issue-parent-gate.mjs
status=$?
[ "$status" -eq 2 ] && exit 2
exit 0
