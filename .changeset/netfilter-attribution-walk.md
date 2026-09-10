---
"@tapflowio/ios-agent": patch
---

<!-- changelog: internal — no behaviour change; the walk decides the same things, from a seam a test can reach. -->

The last part of #690. `attribute(pid)` — the climb that decides whether a flow belongs to a
simulator, to the Mac, or to nothing anyone can name — moves to `attributeWalk`, with its three
live-kernel reads behind a `ProcessReader` a test can stand in for.

Twelve cases and twelve mutations cover what the climb decides: where it stops and what the stop means,
that an unreadable executable path still reaches the arguments, that a cache hit skips the argument
read entirely, that a failed read is counted apart from a host flow, and the depth bound from both
sides.
