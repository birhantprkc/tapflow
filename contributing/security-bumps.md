---
type: rules
topics: [dependencies, security, tooling]
status: living
---

# A security bump is `pnpm update` first, and an override only if that fails

> The rules themselves are stated in the root [AGENTS.md](../AGENTS.md): reach for `pnpm.overrides`
> last, run `pnpm overrides:audit` before adding an entry, derive the key from the GHSA advisory
> rather than the Dependabot alert, and scope the key and its replacement to one major line.
> **This file is the why.**

Reach for `pnpm.overrides` last. The usual situation is not that the declared range forbids the
patch — it is that the **lockfile does not re-evaluate ranges**. The patch nearly always lands
inside the same major, the declaring range is a caret, and `pnpm update <pkg>` takes it with no
permanent entry to maintain. An override is a workaround for a stale lockfile, and it outlives the
problem: measured on 2026-08-06, all fourteen entries in the block were inert — removing the whole
thing and resolving cold produced a byte-identical tree. Measured again on 2026-09-03 with eight
entries left: same answer, and they were retired then. **`pnpm.overrides` is empty today**, so an
entry added now is the only one, and nothing else in the block will hide it going stale.

Stale is the failure mode to watch for, because it does not look like one. Three of those eight
pinned `fast-uri` up to a floor the advisories had since moved past — 3.1.5 where 3.1.6 was
required — so had they ever fired they would have landed on a version that was still affected while
reading, to anyone scanning the block, like the matter was handled.

`pnpm overrides:audit` judges each entry: still needed, correct, and whether it reaches a published
package's production tree. Run it before adding an entry, and when one is added, plan to remove it.

**Derive an override key from the GHSA advisory, never from the Dependabot alert.** An alert reports
only the affected range matching the version you happen to have installed. `fast-uri` patched three
lines within fourteen minutes of each other; the alert showed one, and #471 shipped a key that left
the current major line unguarded. The same mistake in #469 inherited a lower bound from an earlier
advisory. Read the whole affected set:

```bash
gh api graphql -f query='{securityVulnerabilities(ecosystem:NPM, package:"NAME", first:100){
  pageInfo{hasNextPage endCursor}
  nodes{advisory{ghsaId severity} vulnerableVersionRange firstPatchedVersion{identifier}}}}'
```

Page it. `axios` has 73 advisories and `undici` 67, and a page that stops short reads exactly like
"no such advisory" — the direction that hides a floor you needed. Repeat with `after:"<endCursor>"`
until `hasNextPage` is false. `pnpm overrides:audit` does this for you.

Scope the key to the major line its replacement targets — pnpm matches by range **intersection**,
not containment, so a bare `<X` reaches every major below it and would force a cross-major jump on
a consumer that declared one. Cap the replacement for the same reason.
