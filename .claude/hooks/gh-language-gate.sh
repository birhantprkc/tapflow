#!/bin/bash
# PreToolUse(Bash) gate: a PR or issue title and body are written in English.
#
# **It replaces an inline perl regex in `settings.json`**, which matched
# `/gh\s+(pr|issue)\s+(create|edit)/` against the whole command and blocked anything that also
# contained Hangul. Measured: a `node -e` script investigating this very gate carried
# `gh issue create` inside a JS string literal and Korean in a `console.log` label, and was refused
# as an issue creation. It creates no issue. That is the mistake `issue-parent-gate.sh` next to it
# was written to end, still live one hook over.
#
# The regex was also blind in the other direction. It saw only the command text, so Korean in a
# `--body-file` — the form CONTRIBUTING tells everyone to use — was never looked at.
#
# **The prefilter reads the command, not the payload.** Matching the whole JSON meant the `cwd` field
# supplied words the command never had: in a checkout under `personal-project`, `*gh*pr*` reduced to
# "contains gh", and `rg -n "highlight"` paid for a node process. Falling back to the raw input when
# `jq` cannot produce a command keeps the gate on rather than silently off.
#
# **The root comes from the session's own checkout**, the way `adversarial-review-gate.sh` resolves
# it (#699). Deriving it from `CLAUDE_PROJECT_DIR` alone means a session in a worktree — or one whose
# project dir points anywhere else — finds no `scripts/` and the gate turns itself off.
#
# **It matches what the shell would leave, not what was typed.** The prefilter reads raw text while
# the parser reads a tokenized command, so `g"h" issue create` -- a real invocation -- was not in the
# raw text and the gate exited before the parser ever saw it. Removing the quotes and backslashes the
# shell removes closes that for nothing, because squashing only ever *widens* what reaches the
# parser, and the parser is the half that decides. It remains a prefilter rather than a decision:
# `$VAR` and `$(...)` are unresolved here, as they are there.
#
# **This file is only the prefilter.** Deciding needs the command tokenized and the body read, which
# is `scripts/gh-language-gate.mjs`, where it is tested.

input=$(cat)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$cmd" ] || cmd=$input


# The characters the shell strips on the way to a command word. Two substitutions rather than one
# bracket expression: a backslash inside one is its own argument about quoting, and this has to be
# read correctly by whoever edits it next.
squashed=${cmd//[\"\']/}
squashed=${squashed//\\/}

case "$squashed" in
  *gh*issue*|*gh*pr*) ;;
  *) exit 0 ;;
esac

root=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)
if [ -n "$root" ] && top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null); then
  root=$top
else
  root="${CLAUDE_PROJECT_DIR:-.}"
fi
cd "$root" 2>/dev/null || exit 0

[ -f scripts/gh-language-gate.mjs ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# **Only status 2 is a verdict.** node's own failures are not — a missing binary exits 127, an
# import error exits 1 — and propagating those made every matching command in the session report a
# hook error while blocking nothing, which is the opposite of the fail-open promise above.
printf '%s' "$input" | node scripts/gh-language-gate.mjs
status=$?
[ "$status" -eq 2 ] && exit 2
exit 0
