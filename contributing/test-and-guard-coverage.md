---
type: rules
topics: [testing, static-checks, review, quality]
status: living
related: [adversarial-review]
---

# What a test or a guard has to execute to actually hold its claim

> Read this **before writing a static check, or a test that asserts something does not happen.**
> Companion to [adversarial-review.md](./adversarial-review.md), which covers the review itself. This
> side is about the moment before there is anything to review.

Rules 1–4 come from a program-length wire-contract redesign (`protocol` / `relay` / both agents /
two clients / dashboard, ~10 merged PRs). Across those PRs the **majority of review findings were
defects in the author's own work**, and the same four shapes kept producing them; each was paid for
at least twice.

Rule 5 comes from a later and much smaller change — the repo's own PreToolUse gates — and is here on
different grounds. It was paid for once, but what it cost was the remedy this document prescribes
everywhere else: rules 2 and 4 both answer "how do you know the test holds?" with *run the mutation*,
and one of the three probes below survived sixteen of them.

The common root: **a claim written in prose reads, to the author and to a reviewer, as a claim that is
enforced.** A green suite is not evidence that a test holds what its name says. It is evidence that
nothing in the suite currently fails.

---

## 1. A check must execute the lesson its own header cites

The **first draft** of `scripts/__tests__/clientOutboundTyped.test.mjs` opened by citing a sibling
check's failure — *"anchoring on a name's spelling gets bypassed"* — and was then written **in exactly
that way**: two assertions pinned to the literal `private send(`. One extra helper, and a mistyped
message went to the wire with 7/7 green. (The file on disk is the corrected version: it now anchors on
**serialization** — the enclosing function of a `JSON.stringify` — and its header records what the
first draft got wrong. Read it there rather than trusting this paragraph.)

Writing the lesson down reads as having applied it. So when you write a check, **mutate every claim in
its header.** If the header says "anchored on X rather than on the name", run the mutation that
changes the name. If a claim cannot be made to fail, it is decoration — delete it or make it real.

And **read the sibling that already got it right.** `agentSendTyped` had reached a rule over three
rounds (*"in a file that writes to a socket, `JSON.stringify` appears only inside the send helper"*)
one file away. Citing its existence while reinventing the shape — more weakly — is how the same hole
gets reopened.

This is the static-check form of "the reason written beside the code is part of the fix." **If the
stated reason is false, that is a defect in the check, not in its documentation.**

## 2. A test that asserts absence is verified only by the mutation that creates the absence

Four tests pinned *"a request with no id is dropped"*. All four were green, all four shipped, and
**all four passed for the wrong reason**:

```ts
const reply = waitForTypeOrNull(sock, type, 0)   // 0ms deadline → null on the next tick
send(...)
await barrier(sock)                              // the round trip finishes after that
expect(await reply).toBeNull()                   // passes whether or not it was dropped
```

A test asserting **existence** (`expect(x).toBe(y)`) is self-verifying: a wrong value fails it. A test
asserting **absence** is not — passing when nothing happens *is its definition*, so it cannot
distinguish that from a bug that makes nothing happen.

→ **A test using `toBeNull`, `not.toHaveBeenCalled` or `not.toBeInTheDocument` gets the mutation that
creates the absence, before it is committed.** In the round that produced those four, the only sound
test was the one whose mutation had been run.

**Order:** send → `await barrier` → *then* read the recording with a 0ms deadline. The barrier is
evidence the other side finished; a deadline is a guess about timing.

**And a passing mutation proves "can fail", not "always fails".** After those four were fixed, one was
still a race — right order, **wrong socket**:

```ts
browser.send(request)     // trigger on the browser connection
await barrier(agent)      // synchronised on the agent connection
```

WebSocket ordering holds **within a connection**, so the relay answering the agent's ping is no
evidence it processed the browser's request. That test failed correctly under mutation anyway, because
today's relay happens to be synchronous enough — so the mutation did not disprove the race.

→ **Synchronise an absence assertion on the connection the trigger went out on.** Different
connections for trigger and observation need two barriers, trigger side first. A trigger that is a
direct function call (an agent test calling `handleRelayMessage`) involves no socket, so the
observation-side barrier alone is enough — that distinction is why only one of the four needed the fix.

## 3. A guard must not enumerate using the mechanism it forbids — and a spelling assertion needs a structural twin

A guard forbidding file enumeration via `git ls-files` was bypassed **four ways** by one reviewer, each
with the hole open and the whole suite green:

- **Move the call to a sibling helper and it is out of range.** The scan looked at `*.test.mjs` only —
  and the very change that added the guard had created the helper idiom it needed to cover. The next
  person writes `trackedFiles.mjs`. → scan recursively, and add a **structural** assertion that does
  not depend on spelling ("a module that calls `sources()` must import it from `./sourceFiles.mjs`").
- **The regex required adjacent quotes**, so template literals and string concatenation passed — and
  `git ls-tree` does not contain the forbidden string at all. → **write down that a spelling assertion
  does not catch deliberate obfuscation.** It is a floor, not a fence.
- **`readdirSync` does not recurse but the vitest `include` does**, so checks in subdirectories ran
  while being invisible to the guard.
- **An extraction silently dropped `.d.ts`** — pure coverage loss, and declaration files are exactly
  what one of the three callers is about.

The anti-vacuity floor is what caught a fifth (reusing a source skip-set for a module walk, cutting the
scan to 7 files). **Set that floor from the measured count, not a round number.**

## 4. Aim the mutation at the path that already worked

A slice that gave `error` an address asserted **four times** that each *refusal* names the right
session, and **zero times** that the *success reply* does. Pointing `session:joined`'s address at the
wrong field left relay 620, ios 382, android 263 and the static suite all green — while **no client
could join at all.**

Attention goes the wrong way by default. The new field is visible, so it gets tests; the half that was
already strict reads as "the part that already worked", so it gets none. **The blast radius is the
other way round**: both clients matched the reply strictly, so a wrong address there kills the feature,
while a wrong address on a refusal misdiagnoses one session.

→ When a change adds or moves a field, **mutate the success path first**, then the error paths.

**A suite that waits on a type says nothing about the payload.** Those agent suites use
`waitForType(browser, 'session:joined')` — type only. Green there was never evidence about the address,
and reading the helper is what shows it.

## 5. A mutation proves a test *can* fail, not that it asserts the right thing

Three probes written on one branch measured nothing, and they failed three different ways. Two were
caught by mutation; the third is the one that matters, because mutation cannot reach it.

**The fixture had the property by accident.** A regression test for CRLF handling built its input by
joining lines:

```js
const doc = [`cat > plan.md <<'EOF'`, `… gh issue create …`, 'EOF']
expect(invocations(doc.join('\r\n'))).toEqual([])
```

`join` puts the separator **between** items, so the final `EOF` carried no `\r` — and that last line
is the only one the code compares against the heredoc delimiter. The fixture was LF-terminated
exactly where it mattered, so the CRLF path was never entered and the test passed for a reason
unrelated to its name. Reverting the fix left the whole suite green.

→ **When a fixture's point is a property of the input — line endings, encoding, ordering, size — make
the input carry that property everywhere the code looks, or assert that it does.** `join` is where
this goes wrong most often: it decorates the gaps and leaves the ends bare.

**The failure mode was a hang, not a red test.** A guard existed because `readFileSync` on a FIFO
blocks until something writes. The test called it in-process. `readFileSync` is synchronous, so with
the guard removed it blocked the worker thread and vitest's own `testTimeout` could not interrupt it:
the run went past ten minutes and had to be killed. The regression became a **stopped** CI job rather
than a red one, and a stopped job names nothing while a red one names the test.

→ **A test whose subject is "this does not block" runs the blocking call in a child process carrying
its own timeout**, and asserts on the child's exit signal. In-process, the timeout you configured is
not the timeout that applies.

**The assertion was pointed the wrong way, and its message said so.** This is the one no mutation
finds:

```js
expect(verdict(cmd, { 'b.md': 'English on disk.' }).blocked,
       'disk wins over the payload').toBe(false)
```

The command writes a body file and then sends it, so reading the file **on disk** judges text the
command is about to replace. The assertion was accurate about what the code did and wrong about what
the code should do — and the message string, phrased as a decision, is what made it read as
deliberate. Every mutation passed, because a mutation asks whether the assertion still holds, never
whether it should. It was found by an outside reviewer on a branch that had already run sixteen.

→ **Mutation testing verifies the link between a test and the code. It cannot verify the link between
the test and the requirement.** A test asserting that something is *allowed* earns the same suspicion
as one asserting absence (§2): state what the allowed case would look like if it were the bug, and
check that is not what you have.

**And a fix carries defects at the same rate as the code it repairs.** All three probes were written
in the same session as the code they cover, two of them while fixing findings from a review of that
same branch — and three of that branch's findings were introduced by earlier fixes on it. A round of
review is not a ratchet. The diff that answers it is new code and needs the same treatment, which in
practice means **re-running the mutation set after the fixes, not before**.

---

## Where the rest of these decisions live

Most of them are **not here on purpose.** The rationale for a rule belongs beside the code it governs
(`packages/protocol/AGENTS.md`, `packages/relay/AGENTS.md`, the header comment on a hook, the
docstring on the function), and this
directory's own rule is to read that record before changing the code it describes. A second copy here
would go stale independently of the first — which is the failure mode
[adversarial-review.md](./adversarial-review.md) documents under "the justification is part of the
change".

What earned a place here is the subset with **no code to sit beside**: rules about what a test or a
guard must *execute*, which are otherwise remembered rather than enforced.
