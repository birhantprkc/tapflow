---
'tapflow': patch
---

**`tapflow migrate net-filter` now checks that the filter actually came back before saying it did.**
The host binary's exit 0 means macOS did not refuse the change, which is smaller than "it works" —
the configuration reaches the provider afterwards with nothing coming back — and by that point the
command has switched the filter off in order to replace it safely. So a run could report *iOS network
control is available now* over a Mac where nothing was filtering.

It now waits, up to thirty seconds, for a filter to report itself running, and leaves as soon as one
does. When none appears it says so instead of claiming success, and points at `tapflow doctor ios`,
which answers the same question from the same place. Your network is unaffected either way: a filter
that is not running blocks nothing.
