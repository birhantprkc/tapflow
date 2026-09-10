#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): editing prose under `docs/` at any depth injects a reminder to run the
# ai-tells detect pass. A nudge, not a gate — the gate is at Stop (docs-aitells-gate.sh).
#
# **English, because a contributor's agent reads it.** `.claude/` is committed, so these hooks fire
# for anyone working in the repo with Claude Code — measured: #698 arrived from a first-time
# contributor carrying a `.work/reviews/` record, which exists only because a hook demanded one.
# A Korean-language block is unreadable to exactly the people AGENTS.md says to write English for.
set -euo pipefail

input=$(cat)
fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')

case "$fp" in
  */docs/*.md)
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "You changed prose under docs/. Run /ai-tells detect before finishing (watch for translationese in KO, em-dash asides, and word order). Finishing without running ai-tells at least once this session is blocked at the Stop step."
      }
    }'
    ;;
esac
exit 0
