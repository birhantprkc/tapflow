// Every gate that fires is named in AGENTS.md, and speaks to whoever it stops in English.
//
// **`.claude/` is committed, so these hooks fire for contributors too.** #698 arrived from a
// first-time contributor whose PR body named a `.work/reviews/` record — a file that exists only
// because `adversarial-review-gate.sh` refused to open the PR without one. That gate had a rule in
// AGENTS.md to point at. Four of the six had none, so a contributor could be stopped by machinery
// the repo never mentions, and two of them said so in Korean — to exactly the people the same
// document says to write English for.
//
// The pairing is what makes this checkable at all: a hook is enforcement, and enforcement without a
// stated rule is a wall with no sign on it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')
const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'))
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')

/** Every hook script `.claude/settings.json` wires, by basename, in event order. */
const wired = Object.values(settings.hooks ?? {})
  .flat()
  .flatMap((group) => group.hooks ?? [])
  .map((h) => /([A-Za-z0-9._-]+\.sh)/.exec(h.command ?? '')?.[1])
  .filter(Boolean)

const HANGUL = /\p{Script=Hangul}/u

/** The text a hook writes to whoever it stops: a `reason:` line or a `Blocked:` message. */
function contributorFacingText(file) {
  const src = readFileSync(join(root, '.claude/hooks', file), 'utf8')
  return [
    ...src.matchAll(/^\s*reason:\s*"([\s\S]*?)"\s*$/gm),
    ...src.matchAll(/^\s*(?:echo|printf)\s+"(Blocked:[\s\S]*?)"/gm),
    ...src.matchAll(/additionalContext:\s*"([\s\S]*?)"\s*$/gm),
  ].map((m) => m[1])
}

describe('a wired hook is a documented hook', () => {
  it('names every one of them in AGENTS.md', () => {
    // Named rather than counted, so a failure says which hook to write a rule for.
    expect(wired.filter((h) => !agents.includes(h))).toEqual([])
  })

  it('found the hooks that are wired today', () => {
    // The anti-vacuity floor: an empty `wired` satisfies the assertion above by having nothing to
    // disagree with, which is what a changed settings shape produces silently.
    expect(wired.length).toBeGreaterThanOrEqual(6)
  })
})

describe('a gate speaks to whoever it stops', () => {
  it('carries no Korean in the text it shows them', () => {
    const offenders = wired
      .flatMap((h) => contributorFacingText(h).map((text) => ({ hook: h, text })))
      .filter(({ text }) => HANGUL.test(text))
      .map(({ hook }) => hook)
    expect([...new Set(offenders)]).toEqual([])
  })

  it('is reading a message from each hook that has one', () => {
    // Same floor, one level down: a regex that stops matching makes the assertion above vacuous
    // rather than failing. Measured — five of the six write something when they stop or nudge;
    // `adversarial-review-gate.sh` builds its message across several lines and is excluded here
    // rather than counted, because a partial read would be worse than a named gap.
    const withMessage = wired.filter((h) => contributorFacingText(h).length > 0)
    expect(withMessage.length).toBeGreaterThanOrEqual(4)
  })
})
