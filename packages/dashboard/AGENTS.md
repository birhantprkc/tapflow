---
type: rules
topics: [dashboard, react, ui]
status: living
---

# dashboard — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## Design Reference

Before any design or frontend work, read **[DESIGN.md](./DESIGN.md)** and follow the color tokens, typography, and elevation rules defined there.

## WHAT

React SPA team dashboard: provides the simulator viewer, build comments, and team invite screens.
The audience is the whole team (PO, PM, designers, backend, QA) — not just QA. See root [AGENTS.md](../../AGENTS.md) for the two testing modes (manual vs. AI Agent via MCP).
**No standalone deployment** — bundled to `dist/` via `vite build`, then copied to the relay package's `public/` directory and served directly by the relay server.

### App Center Structure

`/app-center` route. Left app list sidebar + center Release Accordion + Build cards.

- **App sidebar**: `GET /api/v1/apps` → selecting an app manages state via `?appId=N` URL parameter.
- **Release Accordion**: `GET /api/v1/builds?app_id=N` → grouped by `version_name` (`groupByRelease()`). No dedicated `releases` table — UI grouping uses `version_name` metadata.
- **Build card**: shows `build_number`, `platform`, `status_label`, uploader, `uploaded_at`. Inline status dropdown. **"Start QA" CTA** → `/app-center/build?id={build_id}`.
- **Upload**: `UploadBuildDialog` — iOS `.app.zip` or `.tar.gz`/`.tgz` (EAS simulator build) / Android `.apk`. `version_name` / `build_number` are auto-extracted from plist, so no manual input fields.

## HOW

- **Stack**: Vite + React 19 + React Router v7 + Shadcn/Tailwind + next-themes
- **Structure**: `src/` — app entry, router, pages; `components/` — shared components; `hooks/` — custom hooks; `lib/` — utils, types, API client
- **Routing**: `BrowserRouter`-based. `/login` and `/invite` are public. Everything else is protected by `DashboardLayout` via `useAuth` (redirects to `/login`).
- **Auth**: Session confirmed via `GET /api/v1/auth/me`. HttpOnly cookie (not readable from JS).
- **Streaming**: set `binaryType = 'arraybuffer'` in `useRelay`, branch on `e.data instanceof ArrayBuffer` for binary frames.
- **Message shapes live in [`@tapflowio/protocol`](../protocol/AGENTS.md)**, imported with `import type` so nothing lands in the bundle. `send()` takes `BrowserToRelay`, so a new outbound message has to be added to that union first. What the viewer *receives* is **`BrowserInbound`**, re-exported from `lib/types.ts` so view code keeps one import site.
  - This package used to hand-copy that inbound union as a local `RelayMessage`, and it drifted: three error types were `sessionId?` against protocol's required, `session:joined.capabilities` was optional against required, four members were declared with no `sessionId` the wire always carries, and four more were missing entirely. Nothing reported any of it. The name also collided with the relay's own `RelayMessage`, which is its *inbound* type — a different set.
  - **Do not type an injected test message with `as never` or a local shape.** Both accept anything, so the fixture is free to disagree with the wire and the suite will not say so. `useClipboardBridge.test.tsx` builds replies as `ClipboardBridgeMessage` via an annotation; when that replaced `as never`, five fixtures in `DeviceViewer.rebind.test.tsx` turned out to be sending a `device:booting` with no `sessionId` — a message the wire does not produce, and one that bypasses the viewer's session scoping.
- **Dev server proxy**: `vite.config.ts` proxies `/api` and `/uploads` → `http://localhost:4000`.
- **Build order**: dashboard first → relay second (`agent-core → dashboard → relay`).

## Testing

- `pnpm test` is always run foreground (terminal). **Never run vitest as a background process** — worker forks accumulate as zombies and exhaust CPU/RAM.
- If a test appears to hang, Ctrl+C immediately and diagnose. Do not re-run without fixing the root cause.
- Components that combine multiple `useEffect` + `react-hook-form` `Controller` + `useWatch` (e.g. `DefaultSettings`) can hang in jsdom under full render. `vitest.config.ts` has `testTimeout: 10000` as a safety net — a timeout failure means the test setup needs fixing, not more retries.
- When mocking `fetch` in a component that fires multiple concurrent `useEffect` fetches (e.g. `GET /api/v1/settings` + `GET /api/v1/apps`), use URL-based dispatch (`mockImplementation((url) => {...})`) instead of `mockResolvedValueOnce` chains — call order is non-deterministic.

### Every browser-inbound message has a declared disposition

`lib/inboundDisposition.ts` says, for each of the 29 messages a browser socket can receive, either which
files handle it or why it is deliberately ignored. It is written with
`satisfies Record<BrowserInbound['type'], Disposition>`, so **a message added to the wire breaks that file**
until someone picks a category.

`mcp-server` and `flow-runner` have the same table as of #544, with their own categories and a check that
also holds an `ignored` entry to the absence of a handler.

It exists because "handled elsewhere", "deliberately ignored" and "nobody wrote it" all look like an absent
branch. Six messages were being dropped and the three reasons were indistinguishable — one of them turned
out to be a real bug hiding inside a *handled* type (`error`, whose meaning was carried in free prose).

**Do not branch on a message's `message` field.** It is prose the producer owns. `error` carries a closed
`reason`; branch on that, exhaustively.

### The lifecycle replies are correlated **selectively**, and the exceptions are the point

`DeviceViewer` mints a `requestId` for every `device:boot` it sends and gates on it — but not uniformly,
and the disposition table above cannot show the difference. Three rules, each holding a defect shut:

- **An *uncorrelated* `device:boot-error` is always reported, and a correlated one only when it answers
  the boot this viewer is still waiting on.** The first half is #426: `AndroidAgent.restartVideoStream`
  sends this message for a stream that died mid-session, with no `device:boot` behind it and so no id it
  could carry, and this branch is the only surface that reports it — gate that and a dead stream becomes a
  picture that has quietly stopped updating. The second half arrived with #526: both agents now answer a
  boot they abandon rather than going silent, so the id of a boot **this viewer replaced itself** comes
  back as a failure while its replacement is running normally.
  Judged against the latest boot id, **never against `bootIdsRef` membership**. `session:joined` clears
  that set and it arrives again on every socket reconnect, so one Wi-Fi blip leaves a still-running boot's
  id outside the set — a membership gate would then report exactly the failure this rule exists to
  suppress. The gate sits above the `rebindRef` release for the same reason: the boot that replaced this
  one owns that release.
- **`setDeviceReady(true)` runs before the gate.** The relay replays a cached `device:ready` to a
  re-joining viewer as `{ type, payload }` — no `sessionId`, no correlator — and clearing the spinner is
  what that replay is *for* (#440).
- **Everything else on `device:ready` is gated, with absent accepted.** A mismatched id is rejected; an
  absent one is not, because both the replay and an agent predating the echo arrive that way — and while
  the correlator is optional those two are indistinguishable. So what this newly catches is a straggler
  from an earlier boot cycle releasing the current rebind, and *not* the replayed ready firing a duplicate
  install, which stays as it was.

And a fourth rule, about the set rather than the gate — **`bootIdsRef` is cleared on `session:joined` and
nowhere else.** Not on `device:booting`, even though that branch is where every other per-cycle record is
dropped and its comment says so: both agents send `device:booting` *before* the `device:ready` answering the
same boot, so a boot id has to span it. Clearing it there rejects every real ready, and the failure is quiet
in the worst way — the spinner clears, the device looks healthy, and the app is never installed. That one
was found by review after the first three were already pinned: the tests held what the gate did **with** an
id and nothing held how ids entered or left the set.

Getting any of the three the other way round passes typecheck and most of the suite:
`src/__tests__/DeviceViewer.lifecycleCorrelation.test.tsx` is what fails. Nothing else can — the
correlator on these replies is optional, so neither the compiler nor
`scripts/__tests__/correlatedRequestsGated.test.mjs` sees this pair at all. Background:
「Lifecycle correlation」 in [protocol/AGENTS.md](../protocol/AGENTS.md).

### `input:error` is shown per input, and there is no session-level input state

A failed input surfaces as a toast keyed on the wire `reason` (`lib/inputErrorNotice.ts`), or is shown
nowhere for the two reasons that fix themselves. `input:done` is **not handled at all**.

A latched "input unavailable" line on the status card was designed and discarded, and it will look
like the obvious improvement to whoever reads this next. It cannot be made honest on the current
protocol, for three independent reasons:

- **Nothing announces that input is working again.** iOS replaces a dead helper eagerly and is
  injecting ~200ms later with no message to the browser, so no edge carries *evidence of input health*.
  Lifecycle messages do arrive — `session:rebound` on an agent restart, `session:joined` on a socket
  reconnect, both already handled above — but neither is that evidence: with a helper binary still
  missing (#464) a rebound would clear the latch and the next tap would raise it again. The only
  signal that would mean anything is a successful input, and `channel-unavailable`'s own advice is *do
  not blindly retry*, so a latch's clear edge needs the tester to do what the UI just told them not
  to.
- **The acks are unordered.** A success is awaited and a refusal is not, so an earlier input's
  `input:done` can arrive after a later input's `input:error` and clear a latch that is still true. Not
  via `ackInput`'s boot verify, which looks like the culprit and is cached on `device:ready` — the
  paths that reorder on every input are Android awaiting the dispatch itself before acking
  (`pressButton` → `adb shell input`, measured 26–29ms steady state) and iOS acking a key only after
  awaiting `hideSoftwareKeyboard`, while a `malformed` or `channel-down` refusal reaches `ws.send`
  within microtasks.
- **An ack does not say which channel answered.** On Android a button always takes the adb path, while
  touch takes the pointer channel whenever a video backend is up — which is every streaming session,
  the only kind a tester has. So pressing Home to check whether input works at all succeeds on a
  session whose touch channel is dead, and under the latch that success erased the warning.

Instead the toast's own lifetime carries the state: repeats reuse `id`, which sonner refreshes rather
than stacks, so it stays up while inputs keep failing and fades on its own when they stop. **Being
observed rather than stored is the point** — there is no clear edge to get wrong.

Copy lives here rather than in the agents because `message` on the wire is free prose each agent owns
and cannot be localised; `reason` is the contract. `message` rides along as the description, where its
diagnostic detail (`unknown key code: KeyFoo`) belongs. Absent or unrecognised reasons resolve to
`channel-unavailable` — absence means *unknown*, never *fine*.

Suppressed entirely while the agent is away. An absent agent cannot send this, so in that state the
*relay* answers every terminal input itself (`agent offline`, `channel-unavailable` since #492); a
tapping tester would refresh the toast indefinitely, with advice contradicting the status card, which
already says the relay is holding the session open and waiting.

A persistent indicator needs a protocol-level input-health signal, or acks that identify their channel
and arrive in order. Two tests guard the decision (`DeviceViewer.inputError.test.tsx`): `input:done`
must do nothing, and a success between two failures must change nothing.

## Where a new device button goes

The device toolbar has four groups, and they are ordered by **what the tester is doing to the
device**, not by how the feature is built:

> **Navigation → Device → Capture → Environment**, and inside each group the ones reached for most
> come first.

| Group | What belongs in it | Today |
|---|---|---|
| **Navigation** | Move around the app or the OS. Press it and it is over. | launch, home, back, recent apps, deeplink |
| **Device** | Leave the device in a condition that stays until somebody changes it back. | software keyboard, volume, sleep, rotate, restart |
| **Capture** | Take the current state out of the session. | screenshot, recording |
| **Environment** | Change what the device is sitting in. | network on/off |

**This exists so that "where does this go?" has an answer before anyone argues.** GPS mock →
Environment. Shake → Device. Log download → Capture. A deeplink is Navigation and not a tool,
because from the tester's side it is "go to this screen" rather than "type a URL".

**A restart is Device rather than a group of its own**, and it closes that group: it acts on the
device the way the power button does, and inside a group the order runs frequent → rare. It is also
the only control here a tester cannot undo, which is why it is the only one behind a confirmation —
the placement rule decides *where*, and destructiveness decides *what it takes to fire it*. Wiping
stays on the selector screen; two irreversible buttons side by side is how #439's accidental erase
happened.

Sticky beats momentary when a button could be read either way — the keyboard is Device, not
Navigation, because a keyboard left up stays up. That is the same reasoning `networkLook` in
`SimulatorToolbar.tsx` gives for the network control having the toolbar's only colour: *a state a
tester deliberately put the device into and will forget about, and forgetting is what makes the next
hour of testing confusing.*

### The order is the same on both platforms, on purpose

A tester moving between iOS and Android should find rotate at the end of Device and the network
control alone in Environment on both. That is why the toolbar takes `navigationSlot` and `deviceSlot`
rather than one `platformSlot`: the viewers hand it buttons already sorted into groups, so where a
button belongs is decided in one place instead of two.

**How far that is enforced, exactly.** `SimulatorToolbar.groups.test.tsx` holds the toolbar's own
group order with stand-in buttons, and `scripts/__tests__/androidButtonsClassified.test.mjs` holds
that every agent button is classified and that each list reaches the slot it is named for. The last
of those is a source-text check — a floor, not a fence. **Nothing renders `AndroidViewer` or
`IOSViewer`**, so a viewer that builds its slots some other way would pass; that is the gap to close
if this ever drifts.

**The dashboard owns the order; the agent owns what exists.** Android's buttons arrive from the
agent's `ANDROID_BUTTONS`, which is a *capability* list — the key codes are why it lives there.
Rendering it in array order leaked that list's ordering out as a layout decision: **a reorder in
`android-agent` moved buttons in the browser**, with nothing on either side to notice. The two
platforms did not actually diverge — the shared buttons sat in the same relative places all along —
so this closes a way for them to, rather than repairing a way they had. `AndroidViewer` names its own
order and looks each button up; a name the agent reports that no group claims does not render, which
is deliberate — a new key code appears once somebody has decided where it belongs, rather than
turning up wherever the array happened to put it.

### When a group gets too long

Nothing is collapsed today: iOS shows eight buttons and Android twelve, which a vertical toolbar
still carries. The point to reconsider is when a single group needs more than about four — that is
when its low-frequency members should move behind a popover and the frequent ones stay on the
surface, rather than the toolbar growing until it runs off the screen.

**Android's Navigation group is already there**, at five whenever a build is loaded: launch, home,
back, recent apps, deeplink. So the threshold is crossed rather than approaching, and it was
Navigation that crossed it — not Environment, which is the group whose *future* members (location,
battery, appearance, locale, time zone, permissions) make it the one to watch next.

**And Device followed it**: the restart (#628) takes Android's Device group to four and iOS's to
three. Both are at the threshold rather than over it, so nothing moves yet — but the next button
either platform adds to Device is the one that should arrive with a popover rather than a slot.

## HOW NOT

- Do not reintroduce the `next` package.
- Do not call the Agent directly from the dashboard — always go through the relay.
- Do not put platform-specific conditionals (`if platform === 'ios'`) in UI components.
- Do not send session recording data to external storage.

---

## Compound

### WebSocket Binary Frame Reception

**When**: receiving and rendering binary stream frames

**How**: `useRelay` receives binary frames (set `socket.binaryType = 'arraybuffer'`, else `e.data` is a `Blob`); `IOSViewer` / `AndroidViewer` render via a decoder chosen by `pickDecoder` (`lib/decoders/`) — WebCodecs on secure contexts, WASM (tinyh264) on plain HTTP, `createImageBitmap` for the JPEG fallback.

**Why** (not obvious from the code):
- Both H.264 tiers paint **straight to a canvas with no `<video>` media element** — WebCodecs decodes to a `VideoFrame`, WASM (tinyh264) decodes to I420 rendered by `YUVWebGLRenderer` — so there is no media-element buffer adding latency. H.264 is hardware-decoded (WebCodecs) on secure contexts; only the JPEG fallback is CPU-decoded (`createImageBitmap`).
- Release the GPU texture/frame every frame (`bitmap.close()` / `VideoFrame.close()`) — otherwise GPU memory leaks per frame.

---

<!-- a11y-lens:begin -->
## Accessibility rules (a11y-lens)

This package is the only one with DOM/client code, so the a11y-lens rules apply here. Staged UI changes are checked at commit time by the root lefthook `a11y-lens` job; findings with `error` severity block the commit.

When writing or modifying UI code (JSX/TSX/HTML), apply the rule set in `node_modules/@a11y-lens/cli/skills/a11y-lens/references/` — read the relevant category before implementing:

- `01-landmarks-headings.md` — document outline, one h1, no level skips, labelled landmarks
- `02-images-alt.md` — alt text that describes function in context; icon-only controls need accessible names
- `03-forms-labels.md` — placeholder is not a label; errors tied via `aria-describedby`; name matches visible label
- `04-aria-widgets.md` — prefer native elements; custom widgets implement the complete WAI-ARIA APG pattern
- `05-keyboard-interaction.md` — full APG key sets, no hover-only affordances, no keyboard traps
- `06-focus-management.md` — overlays move and return focus; async results are announced via live regions

Tip: agents with skills support get richer guidance via `npx skills add jo-duchan/a11y-lens`.

Self-check against these categories before finishing any UI task — it is cheaper than failing the pre-commit gate.
<!-- a11y-lens:end -->
