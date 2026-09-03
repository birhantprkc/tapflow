import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserInbound } from '@/lib/types'
import { __resetFocusModality } from '@/hooks/useFocusArrivalRing'

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
  // The focus modality is module scope on purpose — it has to outlive the remount a restart causes —
  // so it also outlives a test, and a Tab pressed in one would ring the viewer in the next.
  beforeEach(() => { send.mockClear(); toast.error.mockClear(); deliver = null; __resetFocusModality() })

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

  it('catches focus when the restart unmounts the toolbar it was pressed from', async () => {
    // **The restart is the only control that destroys its own toolbar.** Its boot sends
    // `device:booting`, that clears the chrome, and the viewer holding the button goes with it — so a
    // keyboard user is left on `document.body` with nothing named saying the device is coming back.
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })

    expect(screen.queryByRole('button', { name: 'Restart the device' }), 'the toolbar survived the reboot')
      .toBeNull()
    expect(document.activeElement, 'focus was dropped on the body')
      .toBe(screen.getByRole('region', { name: 'Device screen' }))
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

  it('hands focus back to the viewer when the device returns', async () => {
    // **Without this the fix above only moves the drop later**: the region focus was parked in
    // unmounts when the chrome arrives, so focus would fall to `document.body` at the *end* of the
    // boot instead of the start of it.
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME }) })

    const restart = screen.getByRole('button', { name: 'Restart the device' })
    expect(document.activeElement, 'focus was left on the body once the device came back')
      .not.toBe(document.body)
    expect(document.activeElement?.contains(restart), 'focus came back outside the viewer').toBe(true)
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

  it('rings for a focus no pointer placed', () => {
    // **The half that used to be untestable.** It read the class list for `focus-visible:ring-2` and said
    // so: "jsdom evaluates no CSS, so nothing here can watch a ring appear". A className floor cannot
    // fail when the ring stops appearing altogether, which is the exact shape the sibling test below
    // needs a control for. The ring is now a state this suite can read.
    //
    // The ring is the region's only focus indicator, so drawing it is the default and a pointer is what
    // takes it away. An arrival with no press behind it — Tab, a hand-back, an assistive technology —
    // has to be visible whether or not anything can say which of those it was.
    live()
    const region = screen.getByRole('region', { name: 'Device screen' })
    act(() => { region.focus() })
    expect(region.hasAttribute('data-focus-ring'), 'an unattributed arrival draws no ring').toBe(true)
  })

  it('still rings on the hand-back, across the remount the restart puts in between', async () => {
    // **The case the ring exists for.** A restart clears the chrome and the viewer holding the ring goes
    // with it, so the focus `DeviceViewer` hands back lands on a *fresh* instance. Nothing about that
    // arrival tells anyone it happened except the ring: it is programmatic, it is not where the tester
    // was looking, and the region it lands on has `outline-none`.
    live()
    // Driven from the keyboard end to end, because `confirmRestart` clicks — and a press seconds earlier
    // must not still be suppressing the ring by the time the device comes back.
    send.mockClear()
    screen.getByRole('button', { name: 'Restart the device' }).focus()
    await userEvent.keyboard('{Enter}')
    screen.getByRole('button', { name: 'Restart' }).focus()
    await userEvent.keyboard('{Enter}')
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:booting', sessionId: 'mine' }) })
    act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME }) })

    const region = screen.getByRole('region', { name: 'Device screen' })
    expect(document.activeElement, 'the hand-back did not land').toBe(region)
    expect(region.hasAttribute('data-focus-ring'), 'the hand-back arrived with no indicator').toBe(true)
  })

  it('does not ring for a tap, nor when the tester then types at the device', () => {
    // Two defects, one after the other. A `tabIndex={-1}` element is out of the tab order and still takes
    // focus from a *mouse* — a click on anything unfocusable inside it lands here — so a plain `:focus`
    // ring drew itself around the whole viewer on every tap. `focus-visible` answered that, and then the
    // browser re-evaluated it on every keystroke: the viewers forward keys to the device from a `window`
    // listener, so a tester who clicked and then typed lit the ring mid-sentence under a pointer's focus.
    // Both shipped, and it was the user who saw them, not the suite.
    live()
    const region = screen.getByRole('region', { name: 'Device screen' })
    fireEvent.pointerDown(window)
    act(() => { region.focus() })
    expect(region.hasAttribute('data-focus-ring'), 'a pointer arrival drew a ring').toBe(false)

    fireEvent.keyDown(window, { key: 'a' })
    expect(region.hasAttribute('data-focus-ring'), 'typing at the device lit the ring').toBe(false)
  })

  it('does not take focus when a first boot finishes', () => {
    // **The control for the hand-back**, and the same defect in the other direction as the first-boot
    // test above: a viewer arriving is not on its own a reason to move the caret, only a viewer
    // arriving *back* is. Measured — dropping the `parkedFocus` check left every other test green.
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
