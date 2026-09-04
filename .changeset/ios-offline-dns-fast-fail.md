---
"@tapflowio/ios-agent": patch
---

Taking an iOS simulator off the network now fails its requests in about half a second instead of hanging for twenty-five. The filter blocked name resolution along with everything else, and a blocked UDP query returns nothing to its sender — so a resolver waited out its own timeout, and a page that needed a fresh name sat blank for over half a minute. Name resolution passes now; the connection that follows is still dropped, in about six milliseconds.

Only outbound UDP to port 53 is allowed. TCP on that same port stays blocked — it already failed immediately, so opening it would buy nothing and would let a device you took offline hold a connection to anything listening there.

**Your app is affected, though less than everything else was.** tapflow refuses name resolution inside the app under test only where that app uses POSIX resolution; `URLSession` resolves through a path tapflow does not reach, so it now resolves the name and fails when it connects, where a device with no signal would have failed the lookup. An app that treats "the name resolved" as "I am online" will say online while reaching nothing. What is unambiguously better is everything tapflow cannot reach at all — a web view, another app — which used to hang for half a minute.

Encrypted DNS is not covered. DNS-over-TLS could be, and DNS-over-HTTPS cannot be told apart from ordinary traffic; neither is included because nothing has measured whether a simulator uses them when the Mac is configured that way.
