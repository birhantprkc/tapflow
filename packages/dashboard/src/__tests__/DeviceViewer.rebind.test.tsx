import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import type { DeviceBoot, BrowserToRelay } from '@tapflowio/protocol'
import type { BrowserInbound } from '@/lib/types'

// #426 stage 2. When an agent restarts, the relay re-points the session at the new socket and sends
// `session:rebound`. The relay cannot restart the stream on its own — the codec negotiation and the
// tier ride in the browser's own `device:boot` payload — so the viewer has to ask for the device
// again. Until it does, every flag here still describes the agent that died.
const send = vi.fn<(msg: BrowserToRelay) => void>()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

/** Minimal iOS chrome — enough for the platform viewer to mount, which is what makes teardown
 *  observable: with `chrome` set the skeleton is gone, and clearing it brings the skeleton back. */
const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

const boots = () =>
  send.mock.calls
    .map(([m]) => m)
    .filter((m): m is DeviceBoot => m.type === 'device:boot')

const installs = () => send.mock.calls.filter(([m]) => m.type === 'app:install')

/** Brings a viewer to "streaming": joined, device up, chrome delivered, build installed. */
function live(buildId?: number) {
  render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={buildId} />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
  act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME }) })
  if (buildId) act(() => { deliver!({ type: 'app:install-done', sessionId: 's1', requestId: sentId('app:install') }) })
}

/** The correlator the viewer minted for its most recent request of `type`. Read back rather than invented:
 *  a fixture that makes up an id would be testing that the gate rejects it. */
const sentId = (type: string): string => {
  const call = send.mock.calls.map(([m]) => m).filter((m) => m.type === type).at(-1)
  expect(call, `no ${type} was sent`).toBeDefined()
  return (call as { requestId: string }).requestId
}

const rebound = (capabilities: string[] = []) =>
  act(() => { deliver!({ type: 'session:rebound', sessionId: 's1', capabilities }) })

describe('DeviceViewer recovers from an agent restart (#426)', () => {
  beforeEach(() => { send.mockClear(); deliver = null })

  it('asks for the device again', async () => {
    live()
    send.mockClear()

    rebound()

    expect(boots()).toHaveLength(1)
  })

  it('does not erase the device on the way back', async () => {
    // A restart is not a reset request. `resetSentRef` is already spent, so this is automatic —
    // pinned because losing it would wipe a tester's device with no click involved (#439).
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" resetMode="full-erase" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
    send.mockClear()

    rebound()

    expect(boots()[0]?.payload.resetMode).toBe('app-only')
  })

  it('stops showing the dead agent\'s frame', async () => {
    // The device frame `<img>` renders only while `chrome` is set, so its absence is what proves
    // the teardown. Not the "Starting device…" text: the platform viewer carries its own status
    // card, so that string appears whenever `deviceReady` is false — with or without chrome — and
    // a teardown that forgot `setChrome(null)` would pass.
    live()
    const frame = () => document.querySelectorAll('img[src^="data:image/png;base64,"]').length
    expect(frame()).toBe(1)

    rebound()

    expect(frame()).toBe(0)
  })

  it('drops the keyboard state the dead agent was holding', async () => {
    // The software keyboard was up on the old device; the reboot puts it away.
    // `data-active` on the keyboard button is the observable.
    live()
    act(() => { deliver!({ type: 'keyboard:toggled', sessionId: 's1', payload: { visible: true } }) })
    expect(document.querySelectorAll('[data-active="true"]').length).toBeGreaterThan(0)

    rebound()
    act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME }) })

    expect(document.querySelectorAll('[data-active="true"]')).toHaveLength(0)
  })

  it('unsticks a keyboard toggle whose acknowledgement died with the agent', async () => {
    // `swKeyboardPending` marks the toggle unavailable until `keyboard:toggled` comes back. Send it
    // to an agent that then restarts and the acknowledgement never arrives — the control stays that
    // way for the life of the mount. Before rebinding existed this was unreachable: a dead agent
    // unmounted the viewer, so nothing could outlive it.
    //
    // Read from `aria-disabled` rather than the DOM's `disabled`: the button stays focusable so its
    // tooltip can still explain itself, which means the *click guard* is what enforces the state and
    // it is asserted below. `disabled` would have made that guard unreachable and untested.
    //
    // Clicking is what makes the flag true. Delivering `keyboard:toggled` instead — as an earlier
    // version of this test did — sets it *false*, so the assertion held with the clearing line
    // deleted and proved nothing.
    live()
    const kbd = () => document.querySelector('button[data-active]') as HTMLButtonElement
    fireEvent.click(kbd())
    expect(kbd().getAttribute('aria-disabled')).toBe('true')
    // Unavailable *and* why. `aria-disabled` with an unchanged name announces a control nobody can
    // use and gives no reason for it, which is the half the first version of this missed.
    expect(kbd().getAttribute('aria-label')).toMatch(/changing it/i)
    // And a live region, because renaming the button under the focus that just clicked it is not
    // re-announced by NVDA, JAWS or VoiceOver. Mounted before the change, so the region is not
    // inserted in the same commit as its first sentence.
    const status = () => document.getElementById(kbd().getAttribute('aria-describedby')!)
    expect(status()?.getAttribute('role'), 'the toggle has no live region').toBe('status')
    expect(status()?.textContent).toMatch(/changing the software keyboard/i)
    // Still clickable in the DOM, so the guard is the only thing stopping a second request — and the
    // request is what has to be counted. `data-active` does not move until the agent answers, so
    // reading it would have passed with the guard deleted.
    const toggles = () => send.mock.calls.filter(([m]) => m.type === 'input:keyboard:toggle').length
    const before = toggles()
    fireEvent.click(kbd())
    expect(toggles(), 'a second request went out while one was pending').toBe(before)

    rebound()
    act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME }) })

    expect(kbd().getAttribute('aria-disabled')).toBe('false')
    expect(kbd().getAttribute('aria-label'), 'the pending name stuck around').toBe('Software keyboard')
    // Finishing is announced too. Clearing the sentence on success would mean the failure path was
    // announced and the success was the silent one.
    expect(status()?.textContent, 'the region went quiet instead of saying it finished')
      .toMatch(/software keyboard is (up|down)/i)
  })

  it('keeps the installed app, and keeps the control that launches it', async () => {
    // The simulator stayed up across the restart, so the build is still installed. Reinstalling
    // would kill the state the rebind exists to preserve — but skipping it means `app:install-done`
    // never arrives, and that message is the only thing that sets `installed`, which gates Launch.
    live(7)
    const launch = () => screen.queryByRole('button', { name: /launch app/i })
    expect(launch()).toBeInTheDocument()
    send.mockClear()

    rebound()
    act(() => { deliver!({ type: 'device:booting', sessionId: 's1' }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME }) })

    expect(installs()).toHaveLength(0)
    // Naming the control is what makes this an assertion rather than a proxy: counting buttons
    // passes if Launch vanishes and anything else appears in the same render.
    expect(launch()).toBeInTheDocument()
  })

  it('installs again on a boot that is not a rebind', async () => {
    // The skip is scoped to the rebind. A later ordinary boot must still install, or the ref has
    // simply disabled installing for the life of the mount.
    live(7)
    rebound()
    act(() => { deliver!({ type: 'device:booting', sessionId: 's1' }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
    send.mockClear()

    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })

  it('releases the rebind when the re-boot fails', async () => {
    // Otherwise a failed recovery suppresses every install for the rest of the mount.
    live(7)
    rebound()
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', message: 'nope' }) })
    send.mockClear()

    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })

  it('unsticks a launch whose acknowledgement died with the agent', async () => {
    // Same shape as the keyboard toggle: `launching` is set on click and cleared only by
    // `app:launch-done` / `app:launch-error`, both of which die with the agent.
    live(7)
    const launch = () => screen.getByRole('button', { name: /launch app/i }) as HTMLButtonElement
    fireEvent.click(launch())
    expect(launch().disabled).toBe(true)

    rebound()
    act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME }) })

    expect(launch().disabled).toBe(false)
  })

  it('installs after a rebind that interrupted the install', async () => {
    // Finding 1. An agent is at its most fragile mid-install, and a rebind there means the app
    // really is missing. Skipping the install anyway — and setting `installed` on top of it —
    // hands the tester a Launch button for an app that is not on the device.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
    expect(installs()).toHaveLength(1) // in flight — no `app:install-done`
    send.mockClear()

    rebound()
    act(() => { deliver!({ type: 'device:booting', sessionId: 's1' }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME }) })

    expect(installs()).toHaveLength(1)
    // ...and no Launch control until that install reports back. This query is only meaningful
    // because the button carries an `aria-label`; without one it matches nothing and passes
    // whatever the viewer renders.
    expect(screen.queryByRole('button', { name: /launch app/i })).not.toBeInTheDocument()
  })

  it('does not let an unanswered rebind swallow a later boot', async () => {
    // Finding 2. The new agent can fail to answer at all — it is a process that just restarted.
    // A rebind left pending would then absorb the `device:ready` of whatever boot comes next
    // (a socket blip re-sends `device:boot` from the `session:joined` branch), and the install
    // would be suppressed for the rest of the mount rather than for one recovery.
    live(7)
    rebound()
    act(() => { deliver!({ type: 'device:booting', sessionId: 's1' }) }) // ...and then silence
    send.mockClear()

    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })

  it('skips the install for every rebind, not just the first', async () => {
    // Finding 3. A crash-looping agent rebinds more than once, and each rebind boots and gets its
    // own ready. A flag is spent by the first of them, so the second reinstalls — destroying the
    // app state the skip exists to preserve. Hence a count.
    live(7)
    send.mockClear()

    rebound()
    rebound()
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })

    expect(boots()).toHaveLength(2)
    expect(installs()).toHaveLength(0)
  })

  // The one fixture in this file that deliberately disagrees with the wire, and it says so.
  //
  // `session:joined.capabilities` is required in `@tapflowio/protocol`, so `?? []` in the handler is
  // dead against any conforming producer — but nothing validates inbound JSON (see
  // packages/protocol/AGENTS.md), and this package is where a non-conforming agent's message lands.
  // Without the `??` the viewer throws on `agentCapabilities.includes('clipboard')` and the whole tab
  // goes blank.
  //
  // This test exists because #503 removed the accidental cover it had: every `session:joined` fixture
  // in the suite used to be `{ type: 'session:joined' } as BrowserInbound`, omitting the field, so the
  // fallback was exercised everywhere and guarded nowhere. Typing the fixtures correctly is right and
  // it left the fallback with no test at all.
  it('survives a producer that omits capabilities, rather than blanking the tab', async () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    // `live()` minus a conforming join.
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1' } as unknown as BrowserInbound) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME }) })

    // Streaming at all: an unguarded `.includes` on `undefined` throws while the platform viewer
    // renders, and the tree comes down with it.
    expect(document.querySelectorAll('img[src^="data:image/png;base64,"]').length).toBe(1)
  })

  it('says the agent is away instead of leaving a frame that stopped updating', async () => {
    // #426 stage 3. The relay holds the session while it waits for the agent, and this is the
    // window the issue was originally about — a picture that looks live and is not. Dropping the
    // frame is what makes the status card visible, so the tester reads words rather than a still.
    live()
    const frame = () => document.querySelectorAll('img[src^="data:image/png;base64,"]').length
    expect(frame()).toBe(1)

    act(() => { deliver!({ type: 'session:agent-away', sessionId: 's1' }) })

    expect(frame()).toBe(0)
    expect(screen.getByText(/waiting for it to come back/i)).toBeInTheDocument()
  })

  it('stops saying it once the agent is back', async () => {
    // No `session:chrome` afterwards, deliberately. Delivering one mounts the platform viewer and
    // takes the whole status card off screen, so the text would vanish whether the flag cleared or
    // not — measured: the assertion held with the clearing line deleted. The reboot leaves the
    // skeleton up, which is where this can still be read.
    live()
    act(() => { deliver!({ type: 'session:agent-away', sessionId: 's1' }) })
    expect(screen.getByText(/waiting for it to come back/i)).toBeInTheDocument()

    rebound()

    expect(screen.queryByText(/waiting for it to come back/i)).not.toBeInTheDocument()
    expect(screen.getByText(/starting device/i)).toBeInTheDocument()
  })

  it('does not announce the restart twice', async () => {
    // The status card has been saying the agent is away for the whole window. A toast at the moment
    // that message is replaced tells the tester the same thing a second time.
    const { toast } = await import('sonner')
    live()
    act(() => { deliver!({ type: 'session:agent-away', sessionId: 's1' }) })
    vi.mocked(toast.info).mockClear()

    rebound()

    expect(toast.info).not.toHaveBeenCalled()
  })

  it('still announces a restart that arrived with no warning', async () => {
    // The relay only sends `session:agent-away` to an attached browser. A viewer that joined after
    // the hold started never saw it, so the toast is the only thing that tells it.
    const { toast } = await import('sonner')
    live()
    vi.mocked(toast.info).mockClear()

    rebound()

    expect(toast.info).toHaveBeenCalledOnce()
  })

  it('does not report a failed boot during a recovery', async () => {
    // The exact three messages a viewer gets when it re-joins a session whose agent is away: the
    // join succeeds, the `session:joined` branch sends `device:boot` on the strength of it, and the
    // relay refuses that with `agent offline`. Measured on the wire. The waiting state is the
    // truth; a boot failure recorded underneath it is one status-card reordering away from telling
    // the tester a recovery went wrong.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
    act(() => { deliver!({ type: 'session:agent-away', sessionId: 's1' }) })
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', message: 'agent offline' }) })

    expect(screen.getByText(/waiting for it to come back/i)).toBeInTheDocument()
    // Asserting here alone proves nothing: the status card ranks the waiting line above a boot
    // failure, so it stays hidden whether or not it was recorded — measured, the assertion held
    // with the suppression deleted. Clearing the waiting state is what exposes it, and a re-join is
    // how that happens for real.
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })

    expect(screen.queryByText(/boot failed/i)).not.toBeInTheDocument()
  })

  it('clears the waiting state when a later join succeeds', async () => {
    // A join that lands after the agent is back starts a clean session, and the flag is per-mount.
    live()
    act(() => { deliver!({ type: 'session:agent-away', sessionId: 's1' }) })
    expect(screen.getByText(/waiting for it to come back/i)).toBeInTheDocument()

    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })

    expect(screen.queryByText(/waiting for it to come back/i)).not.toBeInTheDocument()
  })

  it('gives up when the relay no longer knows the session', async () => {
    // The other half of the browser-blip path: if the blip outlasts the relay's hold, the re-join
    // is answered `Session not found` and nothing else is ever coming. Ignoring it — every plain
    // `error` but one used to be ignored — leaves the tab waiting on a message that cannot arrive.
    const onSessionEnded = vi.fn()
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" onSessionEnded={onSessionEnded} />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
    act(() => { deliver!({ type: 'session:agent-away', sessionId: 's1' }) })

    act(() => { deliver!({ type: 'error', sessionId: 's1', message: 'Session not found', reason: 'session-not-found' }) })

    expect(onSessionEnded).toHaveBeenCalledWith('agent-disconnected')
  })

  // Regression: `Session busy` reached the viewer and did nothing. Two testers opening the same device
  // is the likeliest collision in a product whose premise is that the whole team opens a browser — and
  // the second tab sat on "Starting device…" waiting for a `session:joined` that cannot arrive.
  //
  // It was invisible from the outside because `error` *was* a handled type: the viewer branched on the
  // free-prose `message` and covered two of the three wordings the relay sends. Branching on `reason`
  // is what makes the third one impossible to forget.
  it('says the device is in use when another socket already holds the session', async () => {
    const onSessionEnded = vi.fn()
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" onSessionEnded={onSessionEnded} />)

    act(() => { deliver!({ type: 'error', sessionId: 's1', message: 'Session busy', reason: 'session-busy' }) })

    // Not `agent-disconnected`: the agent is fine and so is the device. That reason tells the tester to
    // re-pick the Mac, which is advice for a problem they do not have.
    expect(onSessionEnded).toHaveBeenCalledWith('busy-elsewhere')
  })

  it('ignores an away meant for another session', async () => {
    live()

    act(() => { deliver!({ type: 'session:agent-away', sessionId: 'other' }) })

    expect(screen.queryByText(/waiting for it to come back/i)).not.toBeInTheDocument()
  })

  it('ignores a rebind meant for another session', async () => {
    live()
    send.mockClear()

    act(() => { deliver!({ type: 'session:rebound', sessionId: 'other', capabilities: [] }) })

    expect(boots()).toHaveLength(0)
    expect(screen.queryByText(/Starting device/)).not.toBeInTheDocument()
  })
})
