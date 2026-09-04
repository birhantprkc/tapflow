---
"@tapflowio/ios-agent": patch
---

Taking an iOS simulator off the network now fails its requests in about half a second instead of hanging for twenty-five. The filter blocked name resolution along with everything else, and a blocked UDP query returns nothing to its sender — so a resolver waited out its own timeout, and a page that needed a fresh name sat blank for over half a minute. Name resolution passes now; the connection that follows is still dropped, in about six milliseconds.

The app under test is unaffected: tapflow already refuses name resolution inside that app, so it still sees what a real device with no signal sees. What changes is everything else in the simulator — a web view, another app — which used to hang rather than fail.

Encrypted DNS is not covered. DNS-over-TLS could be, and DNS-over-HTTPS cannot be told apart from ordinary traffic; neither is included because nothing has measured whether a simulator uses them when the Mac is configured that way.
