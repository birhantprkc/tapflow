// A session-less entry point on an agent resolves its device through the shared refuser, not by
// insertion order.
//
// **The unit test beside this one covers the entry points that exist; this covers the twelfth.**
// `AndroidAgent.ambiguousDevice.test.ts` asserts that `screenshot`, `setNetworkOffline` and the touch
// methods refuse — but a new member written next year would copy the shape of its neighbours, and if
// the copied shape were `deviceStates.values().next().value` nothing would say so. That is how eleven
// of them accumulated: `IOSAgent.soleOf` had already fixed the defect (#607) and each new Android
// entry point was written from the one above it.
//
// **A source check, so a floor rather than a fence** — a member could resolve a device some third way
// and pass. What it catches precisely is the copy, which is what actually happened.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

/**
 * **Both agents, because the seed shape is in both.**
 *
 * The header's mechanism — each new entry point written from the one above it — is not an Android
 * fact. `IOSAgent` carries the identical `get sessionId()` line, and a new iOS member written from it
 * would reopen #607 with the whole suite green. iOS's other entry points do route through `soleOf`
 * today; the point is that nothing said so.
 *
 * `allowed` names the exemptions rather than pattern-matching them, so the next one has to be a
 * decision. `#617` gives the reason for the one both agents have: a read's worst case is answering
 * about the wrong device, a write's is taking someone else's device off the network — and it answers
 * *before* a device is chosen, so refusing would make "which session am I on" an error on a healthy
 * two-emulator Mac.
 *
 * `refuser` is the anti-vacuity anchor and differs per platform: the two classes reached the same
 * refusal by different helpers.
 */
const AGENTS = [
  {
    file: 'packages/android-agent/src/AndroidAgent.ts',
    allowed: ['get sessionId()'],
    refuser: 'private soleLiveOrNone()',
  },
  {
    file: 'packages/ios-agent/src/IOSAgent.ts',
    allowed: ['get sessionId()'],
    refuser: 'private soleOf(',
  },
]

/** Every `deviceStates.…next().value` in the file, with the member it sits in. */
function insertionOrderPicks(src) {
  const lines = src.split('\n')
  const found = []
  let member = '(top level)'
  for (const [i, line] of lines.entries()) {
    // Members are two-space indented in this class; anything deeper is a nested function.
    const m = line.match(
      /^ {2}(?:private |protected |public |readonly |static |async |override )*((?:get|set) [\w$]+\(\)?|[\w$]+\s*[(=])/,
    )
    if (m) member = `${m[1].replace(/[\s()=]+$/, '')}()`
    // **`entries` too.** It is not a third way of resolving a device, it is the same copy: this file
    // held `keys()` in one member and `values()` in nine others before the fix, so both were already
    // there to be copied from — and `entries()` is what a member writes when it wants the session id
    // *and* the state at once, which is exactly the shape `setNetworkOffline` used to have.
    if (/deviceStates\.(values|keys|entries)\(\)\.next\(\)\.value/.test(line) && !line.trimStart().startsWith('*')) {
      found.push({ member, line: i + 1 })
    }
  }
  return found
}

describe.each(AGENTS)('$file resolves a device through its refuser', ({ file, allowed, refuser }) => {
  const src = readFileSync(join(ROOT, file), 'utf8')

  it('reads a real file with the refuser in it', () => {
    // Anti-vacuity: if the helper were renamed away, every assertion below would pass by finding
    // nothing to complain about, on a class that had lost the fix entirely.
    expect(src.length, 'the agent source parsed as empty').toBeGreaterThan(1000)
    expect(src, 'the refuser is gone — this check no longer guards anything').toContain(refuser)
    expect(src, 'the refusal itself is gone').toMatch(/cannot choose between them/)
  })

  it('leaves only the named exemptions picking the first entry', () => {
    const offenders = insertionOrderPicks(src)
      .filter((f) => !allowed.includes(f.member))
      .map((f) => `${f.member} at ${file}:${f.line}`)
    expect(
      offenders,
      'These resolve their device by insertion order — the entry the relay happened to register\n'
      + '  first, which on a two-device Mac may be somebody else\'s (#617). Route them through the\n'
      + '  class\'s refuser (or its non-throwing variant where absence has always been a no-op). If one\n'
      + '  genuinely belongs to the exemption, add it to AGENTS here with the reason, so the next\n'
      + '  reader can see it was a decision.',
    ).toEqual([])
  })

  it('still has the exemptions, so the list is not stale', () => {
    // The other direction: if `get sessionId()` were changed to refuse, `allowed` would name a member
    // that no longer needs it and the next person would inherit an exemption for nothing.
    expect(insertionOrderPicks(src).map((f) => f.member), 'an exemption is named that no longer picks')
      .toEqual(allowed)
  })
})
