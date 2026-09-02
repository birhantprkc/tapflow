---
'@tapflowio/ios-agent': patch
---

**The check that decides whether the iOS network filter needs replacing now covers two things it
could not see.** Since the extension keeps its version when its inputs are unchanged, anything the
check misses is no longer a harmless extra replace — it is a replace macOS skips **silently**,
leaving that Mac on the old provider with every version reading correctly.

Two inputs live on the maintainer's Mac rather than in the repository, and both change the shipped
extension with no source file moving: the **provisioning profile**, which is the extension's only
sealed resource and is renewed annually, and the **toolchain** that builds it. Both are now compared
before a build, so a renewal or an Xcode upgrade produces a new version by itself.

The build machine's OS version is deliberately left out, even though it sits in the same place. It
moves on every macOS point update, and including it would make a software update replace the filter
on every Mac — the cost this whole mechanism exists to remove.

Nothing changes for anyone installing tapflow. The filter is byte-identical; only the rule that
decides when it needs replacing got stricter.
