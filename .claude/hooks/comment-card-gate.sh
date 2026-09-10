#!/bin/bash
# PreToolUse(Bash) gate: read the comment card before posting a comment under the user's account.
#
# **Wired in `.claude/settings.local.json`, not in the team settings.** Reviewing here is done by two
# people, and a gate meant for the reviewer would misfire on a contributor leaving a note on their
# own PR — #698's author did exactly that. The script is tracked anyway so it gets tests and review:
# every gate in this directory turned out to have a hole that only a test found, and one that judges
# prose will be more subtly wrong, not less.
#
# **Three independent reasons a contributor is unaffected**, and only the third survives a mistake:
#   1. the card lives under `.work/`, which is gitignored — they do not have the file
#   2. the wiring lives in `settings.local.json`, which is gitignored — they do not load this hook
#   3. `scripts/lib/comment-card.mjs` allows the command outright when the card is absent
#
# **PreToolUse, not Stop.** `docs-aitells-gate.sh` runs at Stop, which is right for a file — it can
# still be edited afterwards. A comment is public the moment the command runs.
#
# Deciding needs the command tokenized, so it is `scripts/comment-card-gate.mjs`, where it is tested.
# The prefilter here only decides whether to pay for node.

input=$(cat)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$cmd" ] || cmd=$input

# Match what the shell would leave, not what was typed: `g"h" pr comment` is a real invocation that
# the raw text does not contain. Squashing only ever widens what reaches the parser, and the parser
# is the half that decides.
squashed=${cmd//[\"\']/}
squashed=${squashed//\\/}

# **`graphql` is its own arm rather than a case-insensitive widening of the others.** A comment
# posted through the API is spelled `addComment`, which no lowercase `*comment*` pattern matches, and
# folding the whole filter to case-insensitive would make `*gh*` mean "contains gh" — that is the
# cost this prefilter exists to avoid, measured once already when matching the payload rather than
# the command. `graphql` is a subcommand and is always lowercase, so one more literal arm covers it.
case "$squashed" in
  *gh*comment*|*gh*review*|*gh*replies*|*gh*api*graphql*) ;;
  *) exit 0 ;;
esac

root=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)
if [ -n "$root" ] && top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null); then
  root=$top
else
  root="${CLAUDE_PROJECT_DIR:-.}"
fi
cd "$root" 2>/dev/null || exit 0

[ -f scripts/comment-card-gate.mjs ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# **Only status 2 is a verdict.** node's own failures are not — a missing binary exits 127, an
# import error exits 1 — and propagating those made every matching command in the session report a
# hook error while blocking nothing, which is the opposite of the fail-open promise above.
printf '%s' "$input" | node scripts/comment-card-gate.mjs
status=$?
[ "$status" -eq 2 ] && exit 2
exit 0
