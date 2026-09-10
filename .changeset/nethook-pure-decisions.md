---
"@tapflowio/ios-agent": patch
---

<!-- changelog: internal — no behaviour change; the injected library decides the same things, from a header a test can compile. -->

The decidable half of `src/network-hook.m` moves into `src/hook-decisions.h`: whether a peer is
loopback and therefore must survive a cut, whether a call is refused, whether this process is the one
to hook, and where the offline flag lives. Plain C with no Foundation, so a test compiles it with a
bare `cc` and no simulator SDK — the tests run in the ordinary suite rather than on a macOS runner.

36 cases and 21 mutations. The condition-file path now has a guard comparing the C literal against
the TypeScript that writes it; nothing compiled both before.
