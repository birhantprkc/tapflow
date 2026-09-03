import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserInbound } from '@/lib/types'

// **The wiring, which the hook's suite and the toolbar's suite cannot reach between them** (#628).
//
// `useDeviceReboot` is tested against a handler it registers itself, and `SimulatorToolbar` is tested
// with a stand-in `onReboot`. Between the two sits the chain that actually makes a device restart:
// `DeviceViewer` routes `device:shutdown-*` into a ref, hands `rebootPending`/`onReboot` down through
// `commonProps`, and — the half that exists nowhere else — turns the hook's completion into a
// `device:boot` through the same helper the join and the rebind use.
//
// Deleting the routing branch leaves `inboundDisposition` green: its check looks for a `.type`
// comparison against the literal in a file named in `at:`, which the branch's own condition satisfies
// whether or not it forwards anything. Its comment calls that a floor rather than a fence, and this
// is the fence. The harness is `DeviceViewer.network.test.tsx`'s, which exists for the same reason.
const send = vi.fn()
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
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock('sonner', () => ({ toast }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

/** A viewer with a device on screen — the toolbar lives inside `IOSViewer`, which needs the chrome. */
function live(sessionId = 'mine') {
  render(<DeviceViewer sessionId={sessionId} deviceId="dev-1" />)
  act(() => { deliver!({ type: 'session:joined', sessionId, capabilities: [] }) })
  act(() => { deliver!({ type: 'device:ready', sessionId, payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId, payload: CHROME }) })
}

const sentOf = (type: string) => send.mock.calls.map(([m]) => m).filter((m) => m.type === type)
const shutdowns = () => sentOf('device:shutdown')
const boots = () => sentOf('device:boot')

/**
 * Press the control and confirm the dialog, which is the only way a reboot starts.
 *
 * The record is cleared first because `session:joined` boots the device on its way in — counting
 * from zero here is what makes "a boot went out before the device was down" mean what it says.
 */
async function confirmRestart() {
  send.mockClear()
  await userEvent.click(screen.getByRole('button', { name: 'Restart the device' }))
  await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
}

describe('DeviceViewer — reboot wiring', () => {
  beforeEach(() => { send.mockClear(); toast.error.mockClear(); deliver = null })

  it('offers the control on a live device', () => {
    live()
    expect(screen.getByRole('button', { name: 'Restart the device' })).toBeTruthy()
  })

  it('shuts the device down when the restart is confirmed', async () => {
    live()
    await confirmRestart()
    expect(shutdowns()).toHaveLength(1)
    expect(shutdowns()[0]).toMatchObject({ sessionId: 'mine', payload: { deviceId: 'dev-1' } })
    expect(shutdowns()[0].requestId, 'the viewer sent an uncorrelated shutdown').toBeTruthy()
    // Nothing yet: booting here would race the shutdown it just asked for.
    expect(boots(), 'a boot went out before the device was down').toHaveLength(0)
  })

  it('boots the device once its own shutdown is answered', async () => {
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })

    expect(boots(), 'the shutdown reply did not reach the sequence').toHaveLength(1)
    // **`app-only`, and the assertion is the point rather than the shape.** A restart is not a
    // request to erase (#439), and the selector screen is where wiping is chosen.
    expect(boots()[0]).toMatchObject({ payload: { deviceId: 'dev-1', resetMode: 'app-only' } })
    expect(boots()[0].requestId, 'the boot went out uncorrelated, so its reply answers nothing').toBeTruthy()
  })

  it('boots nothing on a reply to somebody else\'s shutdown', async () => {
    // `useAgentSession` sends three id-less `device:shutdown`s on the way out of a view, and the
    // relay's idle timer sends its own. Every one of them is answered on this session.
    live()
    await confirmRestart()
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: 'someone-else', payload: { deviceId: 'dev-1' } }) })
    expect(boots(), 'a stranger\'s teardown booted this device').toHaveLength(0)
  })

  it('says so when the relay refuses the shutdown', async () => {
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-error', sessionId: 'mine', requestId: id, message: 'agent offline' }) })
    expect(boots()).toHaveLength(0)
    // Out loud, because the control it came from goes back to looking exactly as it did — a click
    // that changes nothing on screen is indistinguishable from a dead button.
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error.mock.calls[0][0]).toContain('agent offline')
  })

  it('forgets the owed focus when the restart is refused', async () => {
    // **The flag is armed by asking for a restart and spent by a viewer coming back — and a refused
    // shutdown produces the first without the second.** Nothing goes down, the toolbar stays exactly
    // where it was, and the flag survives. Later, a stream that drops and recovers clears and restores
    // the chrome on its own, and the caret jumps onto a destructive control nobody pressed: the defect
    // the sibling test below is named for, reached through a restart that never happened.
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-error', sessionId: 'mine', requestId: id, message: 'agent offline' }) })
    // The tester clicks the phone and reads the toast — which, since the screen is no longer a focus
    // target, leaves the caret on the body. That is the state the restore's own guard waits for.
    act(() => { (document.activeElement as HTMLElement | null)?.blur() })

    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME }) })
    expect(document.activeElement, 'a refused restart still moved the caret, one boot later').toBe(document.body)
  })

  it('forgets the owed focus when the boot behind the shutdown fails', async () => {
    // The third path that ends a restart with no viewer returning: the device went down and did not
    // come back. Same consequence as the sibling above, one step further in.
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })
    const bootId = boots()[0].requestId
    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 'mine', requestId: bootId, message: 'no such device' }) })

    act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME }) })
    expect(document.activeElement, 'a failed boot still moved the caret when the device turned up later')
      .toBe(document.body)
  })

  it('parks focus nowhere while the device is away, because there is nowhere worth parking it', async () => {
    // **The booting region is a landmark, not a focus target.** Focus was parked here for a while, and
    // it bought nothing: keystrokes reach the device through `keyboardActive`, which only a pointer
    // press sets, so this region could hold a focus it had no way to use — and an unusable focus still
    // has to be indicated, which drew a ring around the whole viewer on every boot. What the tester
    // loses instead is their tab position for the few seconds the device is away, and it comes back
    // with the device.
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })

    expect(screen.queryByRole('button', { name: 'Restart the device' }), 'the toolbar survived the reboot')
      .toBeNull()
    const region = screen.getByRole('region', { name: 'Device screen' })
    expect(document.activeElement, 'the booting region took focus it cannot use').not.toBe(region)
    // A floor, and named as one: the behaviour above cannot fail while the region is unfocusable, so
    // this is what would notice `tabIndex` coming back and the whole ring problem with it.
    expect(region.hasAttribute('tabindex'), 'the region is focusable again').toBe(false)
  })

  it('does not take focus on a first boot nobody asked for', async () => {
    // **The control for the test above**, and the opposite defect: this branch also renders before the
    // first device arrives, where taking focus is a page grabbing the caret on load. Without it, the
    // assertion above passes on a viewer that focuses this region unconditionally.
    render(<DeviceViewer sessionId="fresh" deviceId="dev-1" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 'fresh', capabilities: [] }) })
    expect(screen.getByRole('region', { name: 'Device screen' }), 'the booting region is not rendered').toBeTruthy()
    expect(document.activeElement, 'the first boot stole focus').toBe(document.body)
  })

  it('puts focus back on the restart button once the device returns', async () => {
    // **Where the tester actually was.** The restart is the only control that unmounts the toolbar it
    // was pressed from, so this is the one focus move the viewer owes anyone — and it is owed to a
    // real button, which is keyboard-operable and comes with the browser's own ring at the size of a
    // button. The button is a fresh element: the one they pressed was destroyed with the toolbar.
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME }) })

    expect(document.activeElement, 'focus was left on the body once the device came back')
      .toBe(screen.getByRole('button', { name: 'Restart the device' }))
  })

  it('does not chase a device that came back on its own', async () => {
    // **The control for the test above.** A stream dying and recovering clears and restores the chrome
    // with nobody pressing anything, and moving the caret onto a destructive control nobody asked for
    // is its own defect — the reason the restore hangs off `onReboot` rather than off the chrome going
    // away. Measured: inferring it from the transition leaves every other test in this file green.
    live()
    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME }) })

    expect(screen.getByRole('button', { name: 'Restart the device' }), 'the viewer never came back').toBeTruthy()
    expect(document.activeElement, 'a boot nobody asked for moved the caret').toBe(document.body)
  })

  it('keeps the empty status region out of the card\'s layout', () => {
    // **A floor, not a fence, and jsdom is the reason.** It evaluates no CSS, so nothing here can
    // observe that `sr-only` is `position: absolute` and therefore not a flex item. What it can hold
    // is that the class is on the node while the node is empty — which is what stops a permanently
    // mounted 0-height child from eating one of the card's `gap-3` on every screen with nothing to
    // say, which is the normal one: connected, joined, ready, installed.
    live()
    // Stated over every empty one rather than one looked up by hand: the toolbar has a status region
    // too, and the invariant is the same for both — a live region with nothing to say must not take
    // up a row. Both are mounted early on purpose, which is what makes the invariant worth having.
    const empty = screen.getAllByRole('status').filter((n) => n.textContent === '')
    expect(empty.length, 'no live region was silent, so this asserts nothing').toBeGreaterThan(0)
    for (const n of empty) {
      expect(n.className, 'an empty live region was left in the flow').toContain('sr-only')
    }
  })

  it('does not take focus when the tester clicks the device screen', async () => {
    // **The defect that started all of this, closed at the source.** A `tabIndex={-1}` container is out
    // of the tab order and still takes focus from a *mouse* — a click on anything unfocusable inside it
    // lands on the container — so every tap on the screen focused the whole viewer, a ring was drawn
    // around it, and `:focus-visible` then redrew that ring on every keystroke because this viewer
    // forwards keys to the device from a `window` listener. None of it survives the region not being
    // focusable. Typing still reaches the device: `keyboardActive` is set by the press, not by focus.
    live()
    const region = screen.getByRole('region', { name: 'Device screen' })
    await userEvent.click(region)
    expect(document.activeElement, 'the tap focused the whole viewer').not.toBe(region)
  })

  it('does not take focus when a first boot finishes', () => {
    // **The control for the hand-back**, and the same defect in the other direction as the first-boot
    // test above: a viewer arriving is not on its own a reason to move the caret, only a viewer
    // arriving *back* is. Measured — dropping the `restoreFocusAfterReboot` gate left every other test
    // in this file green.
    live()
    expect(screen.getByRole('button', { name: 'Restart the device' }), 'the viewer never arrived').toBeTruthy()
    expect(document.activeElement, 'the first boot pulled focus into the viewer').toBe(document.body)
  })

  it('leaves focus where the tester put it while the device came back', async () => {
    // **The guard a comment claimed before the code did it.** A restart takes 30-60s and a tester can
    // Tab out of the booting region in that time — to the header, to anything this harness does not
    // render, which is why the stand-in is appended here. Pulling focus off what they chose is the
    // same defect this effect exists to avoid, aimed the other way.
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    try {
      live()
      await confirmRestart()
      const id = shutdowns()[0].requestId
      act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })
      act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })
      act(() => { elsewhere.focus() })

      act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
      act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME }) })
      expect(document.activeElement, 'the returning device took focus off what the tester chose').toBe(elsewhere)
    } finally {
      elsewhere.remove()
    }
  })

  it('leaves the status sentence sayable, and hides the shapes that have no words', async () => {
    // **Both halves, because either alone passes on the wrong thing.** A skeleton left in the
    // accessibility tree is a run of unnamed boxes between the tester and the sentence; a `busy` or
    // `hidden` ancestor over that sentence takes away the one channel this branch has. Three
    // attempts at `aria-busy` were each wrong in the same way — see the comment beside the shapes.
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })

    const status = screen.getByRole('status')
    expect(status.closest('[aria-busy="true"]'), 'the sentence sits inside a busy subtree').toBeNull()
    expect(status.closest('[aria-hidden="true"]'), 'the sentence is hidden from the tree').toBeNull()
    expect(
      document.querySelectorAll('.animate-pulse:not([aria-hidden="true"] *):not([aria-hidden="true"])').length,
      'a decorative skeleton is still in the accessibility tree',
    ).toBe(0)

    // **And the failure reaches the sentence**, asserted as presence rather than as the absence of a
    // busy flag. Nothing in this branch emits `aria-busy` at all — the three that exist are inside the
    // viewer, which is unmounted here — so counting zero of them was true whatever the code did, and
    // the `device:boot-error` above it did nothing. That is the shape `test-and-guard-coverage.md` §2
    // names: an absence that no mutation can create.
    const bootId = boots().at(-1)!.requestId
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 'mine', requestId: bootId, message: 'no such device' }) })
    expect(status.textContent, 'the failed boot never reached the status sentence').toContain('Boot failed')
  })

  it('leaves the join and the rebind booting the way they did', () => {
    // The reboot made `sendBoot` the single place a boot is sent, and the join is one of the two
    // callers it replaced. Its reset is the one thing the callers disagree on and the disagreement is
    // load-bearing (#439), so it is what this pins.
    live()
    expect(boots()).toHaveLength(1)
    expect(boots()[0].requestId, 'the join stopped correlating its boot').toBeTruthy()
    // **And the rest of the payload, which nothing asserted anywhere in the repo.** `resetMode` was
    // the field this change added and it got a test; `acceptH264` and `secureContext` are the fields
    // it *moved*, and deleting either from the helper left all 471 tests green. The first drops every
    // session to JPEG; the second sends full resolution at a WASM decoder over LAN-HTTP. This is
    // `contributing/test-and-guard-coverage.md` §4 — aim the mutation at the path that already
    // worked. `canDecodeH264` is mocked false in this harness, so the value is fixed.
    expect(boots()[0]).toMatchObject({
      payload: { acceptH264: false, secureContext: window.isSecureContext },
    })
  })
})
