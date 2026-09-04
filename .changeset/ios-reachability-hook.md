---
"@tapflowio/ios-agent": patch
"@tapflowio/cli": patch
---

An iOS app that reads `SCNetworkReachability` is now told when its simulator is taken off the network. Taking a device offline already stopped its traffic, and an app built on `NWPathMonitor` drew its offline state correctly — but Alamofire's `NetworkReachabilityManager` and the older `Reachability.swift` read a different API, and that one kept answering "reachable" while every request failed. The offline screen a tester came to check never appeared.

The fix answers that API too, and **re-fires the callback the library is actually listening on** rather than only changing what a poll would return: a consumer caches what its callback last told it and never polls, so faking the getter alone moves a number nobody reads.

A consumer scheduled on a run loop rather than a dispatch queue is still not re-fired — Alamofire and current `Reachability.swift` both take the queue path.
