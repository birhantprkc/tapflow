---
"@tapflowio/relay": patch
---

Backfills: #739

tapflow no longer pins any transitive dependency. The `pnpm.overrides` block is empty.

Nothing you install changes: every package the block named already resolves at or above its security floor without it, verified by resolving the workspace both ways and comparing — `hono` 4.13.0, `axios` 1.18.1, `undici` 7.29.0, `body-parser` 2.3.0, `protobufjs` 7.6.5, `fast-uri` 3.1.7, `qs` 6.16.0, identical either way.

It is recorded because three of the eight entries had gone stale in a way that mattered. Each pinned `fast-uri` up to a floor its advisories have since moved past — 2.4.4 where 2.4.5 is required, 3.1.5 where 3.1.6 is, 4.1.2 where 4.1.3 is — so had any of them ever taken effect it would have landed on a version that was still affected, while reading, to anyone scanning the block, as though the matter were handled. A fourth named a line with no patched version anywhere, which no override can rescue.
