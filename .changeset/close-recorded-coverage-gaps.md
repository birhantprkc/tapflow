---
"@tapflowio/ios-agent": patch
---

<!-- changelog: internal — no behaviour change; three decisions that had no test now have one. -->

Closes three coverage gaps that earlier reviews found and left written down: the symlink refusal and
the file-mode half of the state-file guard, and the descriptor-scan bound in the injected library.

The first two only change the answer for a root-owned target, so they run as root on CI rather than
being skipped everywhere. The third extracts `tf_fd_scan_bound`, whose `capped` flag is what makes a
truncated scan audible instead of looking like a process with nothing left to cut.
