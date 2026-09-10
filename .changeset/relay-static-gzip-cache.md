---
"@tapflowio/relay": patch
---

Serve the dashboard compressed on plain-HTTP deployments. Browsers only offer Brotli on a secure origin, so over `http://<lan-box>:4000` the relay had only `.br` siblings on disk and sent every asset uncompressed — measured on the largest bundle, 300K where gzip is 92K. The build now emits `.gz` beside `.br` and `serveStatic` picks whichever the client will take, preferring Brotli when both are offered and honouring an explicit `q=0` over a permissive `*`. Assets under `/assets/` are marked `immutable`, `index.html` `no-cache`, and `Vary: Accept-Encoding` is always set so a shared cache cannot cross-serve (#260, #737).
