---
"@tapflowio/ios-agent": patch
"tapflow": patch
---

Keep iOS network control working after the filter is upgraded, and stop the upgrade from taking the Mac's network down.

Replacing the network filter's system extension leaves the previous one holding the XPC service name, so the new provider could not vend its listener and `--confirm` answered "no listener" while the filter was enforcing normally. The agent read that as "not confirmed" and the dashboard's **Take device offline** control went unavailable on every Mac that had upgraded. It now falls back to the provider's own state file, which is the channel the CLI already preferred.

The upgrade also switches the filter off *before* it copies the app into `/Applications`, not only before activating it. Copying the app makes macOS restart the filter session on its own timing, and a filter session going down arms a kernel-wide IP drop — that is what took a Mac's network down for 2m34s on 2026-09-02, and the previous ordering was winning the race by 69 milliseconds.

Also: the provider publishes a rule change immediately instead of waiting for its next idle pulse, its state file names which provider wrote it, and a listener that fails to start now says so rather than logging success.
