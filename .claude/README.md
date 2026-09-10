# .claude/

Claude Code project configuration directory.

`settings.json` and `commands/` are shared across the team and tracked in git.  
`settings.local.json` holds personal permission overrides and is listed in `.gitignore`.

---

## Directory structure

```
.claude/
├── commands/               # Custom slash commands (team-shared)
│   ├── ai-tells.md         # /ai-tells
│   ├── compound.md         # /compound
│   ├── deep-research.md    # /deep-research
│   ├── context-sync.md     # /context-sync
│   ├── promote-decision.md # /promote-decision
│   ├── qa.md               # /qa
│   ├── release.md          # /release
│   ├── work-plan.md        # /work-plan
│   └── write-docs.md       # /write-docs
├── ai-tells/               # /ai-tells rule data (ko/en taxonomy + MIT NOTICE)
├── hooks/                  # PreToolUse/PostToolUse/Stop gate scripts
├── settings.json           # Team settings (hooks, statusLine, etc.)
├── settings.local.json     # Personal settings — gitignored (permissions, etc.)
└── README.md               # This file
```

---

## Custom commands

Invoke with `/` in Claude Code.

| Command | Description |
|---------|-------------|
| `/ai-tells {ko\|en} {detect\|rewrite} [target]` | Detect/fix AI writing tells. `detect` is the default lint/gate (not a laundering tool). External posts (HN/Reddit) = `detect` only — see marketing OVERVIEW.md policy. |
| `/work-plan {topic}` | Create a `.work/` plan document with requirements and test cases. |
| `/deep-research {problem}` | Deep analysis of implementation, bug, or design problems using Fable 5.1. |
| `/qa {target}` | Plan and write tests for the target code. Potemkin and flaky tests prohibited. |
| `/context-sync` | Audit and fix consistency between the codebase and the context documents read before changing it — AGENTS.md, INDEX.md, `contributing/`, `.work/`. Not `docs/`; that is `/write-docs`. |
| `/compound` | Extract reusable patterns from the current session and update AGENTS.md. |
| `/promote-decision [topic]` | Promote a design decision from the private `.work/archive/` into public `contributing/`, without duplicating what is already there. Scans the whole archive when no topic is given. |
| `/release [major\|minor\|patch]` | Run the release procedure — version recommendation through release PR, via changesets. Recommends the bump itself when none is given. |
| `/write-docs {topic}` | Write a VitePress docs page — EN/KO simultaneously, sidebar registration, build verification. |

---

## settings.json vs settings.local.json

| | `settings.json` | `settings.local.json` |
|---|---|---|
| Git-tracked | Yes (team-shared) | No (gitignored) |
| Purpose | hooks, statusLine, plugins | Personal `permissions.allow` entries |
| Example | Completion notification hook | Allow `Bash(gh api *)` |

If `settings.local.json` doesn't exist, create it as an empty `{}` or omit it entirely.

---

## References

- Custom command authoring: [Claude Code slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Project context: [`AGENTS.md`](../AGENTS.md), [`INDEX.md`](../INDEX.md)
- Work logs: [`.work/`](../.work/)
