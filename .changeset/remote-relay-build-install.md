---
'@tapflowio/relay': patch
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
---

**Installing a build works when the relay is not on the same machine as the agent.** It never did. The relay sent the agent its own filesystem path and the agent opened it, which is only true when the two share a disk — so on the topology the guide recommends, a relay on a LAN box with agents on Macs, every install failed. A relay in a container failed the same way for the same reason.

**And it failed by blaming the build.** `unzip` said `cannot find or open`, the agent threw that away, and what reached the browser was "check this is a simulator .app.zip". The archive was fine every time. The tool's own words are in the message now, and a download that fails is reported as a download failing — the three causes a person acts on differently (a bad archive, a relay that cannot be reached, a transfer cut short) had been collapsed into the one sentence that was wrong for all of them.

The relay now mints a single-use credential where it has already checked who owns the session, and serves that one build against it. Nothing is added to any token's permissions: an agent still cannot ask for a build it was not told to install, and `tapflow start` — whose agent runs with no token at all — keeps working, which a permissions-based approach would have broken. The agent builds the address from the relay URL it is already connected to rather than from anything the relay claims about itself, because that is the one address known to be reachable.

A truncated transfer is caught against a size that travels with the instruction rather than against `Content-Length`, which a proxy is free to drop — a check that reads an absent header passes while looking at nothing, and hands on a half a file to be reported as a damaged one. Downloads have a stall timeout, so a half-open socket fails instead of hanging forever and leaving a temp copy of the build behind; the Android install path gained the cleanup it never had. An agent too old to fetch builds is unaffected and installs exactly as before, and the relay says so once in its log rather than guessing whether that agent is somewhere else — it cannot tell, and a check that is wrong in both directions is worse than none.
