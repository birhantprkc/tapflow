---
'tapflow': minor
'@tapflowio/ios-agent': minor
---

**A release that changes nothing but the filter's host binary no longer replaces the system
extension.** `build.sh` stamped one `CFBundleVersion` into the host app and the extension alike, so
any rebuild bumped both and macOS replaced a running provider — which interrupts every new connection
on the Mac until the replacement is up. Three of the six filter rebuilds so far touched nothing
outside `Host/` and paid that for nothing.

The extension now keeps its version when its own inputs are unchanged. Those inputs are everything
except `Host/`, `project.yml` and `build.sh` included, because both change what the extension binary
is without touching a line of Swift — and an extension that changed without its version changing is
replaced **silently**, leaving the old provider running with every check green.

**The first rebuild after this still bumps it once**, since `build.sh` is itself an extension input.
That is one replace, and the change that made a replace survivable landed first.

**Two versions means the checks that compare them had to be told apart.** `isNetFilterCurrent` and
`tapflow doctor ios` were comparing the host app's version against the extension macOS runs, which
only ever agreed because one number was written into both. Left alone, doctor would have reported a
Mac whose `/Applications` app is stale as fully healthy — and that binary is the agent's own path to
the filter, so an older one meets flags it does not understand. Doctor now names the app when only
the app is behind, and says to run `tapflow migrate net-filter`.

**And an install it cannot judge is refused rather than guessed at.** macOS keeps an extension
enforcing when its container app is deleted; the extension's version used to stand in for the host's,
and now only gives a lower bound. In that state tapflow says so and names both remedies instead of
replacing a filter that may be newer than the one it carries.
