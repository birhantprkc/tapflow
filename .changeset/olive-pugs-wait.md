---
'tapflow': patch
---

**`tapflow migrate net-filter` now checks that the filter actually came back before saying it did.**
The host binary's exit 0 means macOS did not refuse the change, which is smaller than "it works" —
the configuration reaches the provider afterwards with nothing coming back — and by that point the
command has switched the filter off in order to replace it safely. So a run could report *iOS network
control is available now* over a Mac where nothing was filtering.

It now waits, up to thirty seconds, for a filter to report itself running — one that started *after*
the install, not the previous provider's last heartbeat — and leaves as soon as one does.
`tapflow setup ios` does the same when it installs the filter.

When none appears the command says so and **exits non-zero** instead of claiming success, because
that state is the one where the configuration is switched on and nothing is answering for it. Usually
it is simply still starting, and `tapflow doctor ios` will say so a moment later; if new connections
on the Mac have stopped, the command names the `--off` that takes the filter out of the path.
