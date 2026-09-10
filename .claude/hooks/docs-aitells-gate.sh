#!/usr/bin/env bash
# Stop: if this session edited any Markdown under `docs/` — at any depth — and never ran
# /ai-tells detect, block finishing and ask for
# the pass. Running ai-tells once satisfies it, so there is no loop.
#
# **English, because a contributor's agent reads it.** `.claude/` is committed, so these hooks fire
# for anyone working in the repo with Claude Code — measured: #698 arrived from a first-time
# contributor carrying a `.work/reviews/` record, which exists only because a hook demanded one.
# A Korean-language block is unreadable to exactly the people AGENTS.md says to write English for.
set -euo pipefail

input=$(cat)

# **Fail open on anything unparseable**, the way every other gate in this directory does. Under
# `set -e` a bare `jq` on a malformed payload took the whole script down with jq's own exit 5, which
# is not the clean pass this is supposed to be — and `pr-merge-guard.sh` is the calibration for how
# long a hook can be wrong about its payload without anyone noticing: 2191 parse failures to 1
# success, across 150 sessions.
tx=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null) || exit 0
[ -f "$tx" ] || exit 0

# Safety net: if the Stop hook has already re-entered after blocking (stop_hook_active), let it
# through so the user can deliberately skip — a scripting error must not block forever.
active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null) || exit 0
[ "$active" = "true" ] && exit 0

# **Counted by parsing the transcript, not by matching its serialisation.**
#
# The previous matcher was a regex requiring `file_path` to be the first key of the tool input, and
# it saw 6 of 34 docs edits: true of `Write`, false of `Edit`, which is what changing an existing
# document uses. Widening the regex fixed that case and left the shape of the bug — review found it
# still blind to `MultiEdit` with `edits` before `file_path` (the `}` closing an edit object ends the
# scan), counting `.mdx` and `.md.bak` for an unanchored `\.md`, and missing the whole record if the
# runtime ever emitted spaced JSON.
#
# `jq` answers all of those at once and the hook already depends on it two lines up, so the
# dependency is not new. Measured against every transcript on this machine: identical counts to the
# regex it replaces, 34 and 34, and 0.37s on the largest (35 MB) against grep's 0.03s — paid once, at
# the end of a session.
#
# `fromjson?` skips a line that is not JSON, which is what a transcript truncated mid-write looks
# like. A `docs` directory that is not the repo's own still counts: this repo has one `docs` tree,
# and over-inclusion on a gate whose override is "stop again" is the safe direction.
tool_paths='fromjson? | .message.content[]? | select(.type=="tool_use")'
edited=$(jq -rR "$tool_paths"' | select(.name=="Edit" or .name=="Write" or .name=="MultiEdit") | .input.file_path // empty | select(test("/docs/.*[.]md$"))' "$tx" 2>/dev/null | wc -l) || edited=0
# Which skills ran. Matched on the invocation rather than on the reminder's own wording, which is
# injected into the transcript and would otherwise let the gate satisfy itself.
ran=$(jq -rR "$tool_paths"' | select(.name=="Skill") | .input.skill // empty | select(.=="ai-tells")' "$tx" 2>/dev/null | wc -l) || ran=0

if [ "${edited:-0}" -gt 0 ] && [ "${ran:-0}" -eq 0 ]; then
  jq -n '{
    decision: "block",
    reason: "This session edited docs/ but never ran /ai-tells detect. Check the prose before finishing — translationese in KO, em-dash asides, word order. To skip deliberately, just stop again and this passes."
  }'
fi
exit 0
