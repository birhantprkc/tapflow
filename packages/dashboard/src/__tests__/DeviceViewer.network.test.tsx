import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserInbound } from '@/lib/types'

// **The wiring, which unit tests cannot reach and static checks do not cover.**
//
// The hook and the toolbar each have their own suite, and between them sits a chain nothing held:
// `DeviceViewer` reads `network-control` out of `session:joined` as a bare string, routes
// `network:*` into a ref, and hands both down through `commonProps` to a viewer that passes an
// **optional** `network` prop to `SimulatorToolbar`. Deleting that prop, or mistyping the capability
// string, removes the feature with no compile error and no failing test.
//
// `inboundDisposition` does not close it either: it checks that a file named in `at:` contains a
// `<msg>.type` comparison against the literal, so removing the `networkHandlerRef.current?.(msg)`
// call while leaving the comparison passes — its own comment calls that a floor, not a fence.
//
// The same gap, one layer down, is why `DeviceViewer.openUrl.test.tsx` exists: the agent side was
// covered and the browser side was not. This is that shape again, and this file is the harness from
// there with the deeplink parts removed.
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
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('sonner', () => ({ toast }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

/** A viewer with a device on screen. The chrome matters: the toolbar lives inside `IOSViewer`, which
 *  `DeviceViewer` renders only once `session:chrome` has arrived. */
function live(capabilities: string[], sessionId = 'mine') {
  render(<DeviceViewer sessionId={sessionId} deviceId="dev-1" />)
  act(() => { deliver!({ type: 'session:joined', sessionId, capabilities }) })
  act(() => { deliver!({ type: 'device:ready', sessionId, payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId, payload: CHROME }) })
}

const button = () => screen.queryByRole('button', { name: /device (offline|online|network)$/ })
const sentNetworkSets = () => send.mock.calls.map(([m]) => m).filter((m) => m.type === 'network:set')

describe('DeviceViewer — network control wiring', () => {
  beforeEach(() => { send.mockClear(); toast.error.mockClear(); deliver = null })

  it('shows no control for an agent that did not announce it', () => {
    // The control, and the one that catches a mistyped capability string: `'network-control'` is a
    // bare literal in `DeviceViewer` compared against a `string[]`, so nothing but this would say it
    // had drifted from `AgentCapability`.
    live(['clipboard'])
    expect(button()).toBeNull()
  })

  it('shows one for an agent that did', () => {
    // Mutation: deleting the `network={...}` prop from `IOSViewer` fails here — and does not fail
    // typecheck, because the prop is optional.
    live(['clipboard', 'network-control'])
    expect(button()).toBeTruthy()
  })

  it('moves the control when the agent reports where the device is', () => {
    // The whole chain in one assertion: capability → prop → hook → ref → routing → render. Mutation:
    // removing `networkHandlerRef.current?.(msg)` from `DeviceViewer` leaves the name unchanged, and
    // `inboundDisposition` still passes because the `msg.type` comparison is still in the file.
    live(['network-control'])
    // Nothing reported yet, so the name carries no direction — the design's own rule, visible here
    // from the outside for the first time.
    expect(button()!.getAttribute('aria-label')).toBe('Toggle device network')

    act(() => {
      deliver!({
        type: 'network:state', sessionId: 'mine', payload: { offline: true, available: true },
      } as BrowserInbound)
    })
    expect(button()!.getAttribute('aria-label')).toBe('Bring device online')
  })

  it('ignores a report addressed to another session', () => {
    // `DeviceViewer` drops these before the routing, and this is the only test that reaches that line
    // for `network:*`. Without it a viewer would take another device's position.
    //
    // Barrier: a report for *this* session afterwards, which must land — so the assertion is not
    // passing because nothing was delivered at all.
    live(['network-control'])
    act(() => {
      deliver!({
        type: 'network:state', sessionId: 'someone-else', payload: { offline: true, available: true },
      } as BrowserInbound)
    })
    expect(button()!.getAttribute('aria-label')).toBe('Toggle device network')

    act(() => {
      deliver!({
        type: 'network:state', sessionId: 'mine', payload: { offline: true, available: true },
      } as BrowserInbound)
    })
    expect(button()!.getAttribute('aria-label')).toBe('Bring device online')
  })

  it('sends the request the click asks for', async () => {
    live(['network-control'])
    await userEvent.click(button()!)

    const sets = sentNetworkSets()
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({ sessionId: 'mine', payload: { offline: true } })
    expect(sets[0].requestId, 'a reply to this could not be matched').toBeTruthy()
  })

  it('toasts a refusal, which is the only thing that says the click went nowhere', async () => {
    // Mutation: dropping `onError` from the viewer's `useNetworkControl` call leaves this silent —
    // the position does not move on a `network:error` either, so nothing else changes on screen.
    live(['network-control'])
    await userEvent.click(button()!)
    const { requestId } = sentNetworkSets()[0]

    act(() => {
      deliver!({
        type: 'network:error', sessionId: 'mine', requestId, message: 'No booted device',
      } as BrowserInbound)
    })
    expect(toast.error).toHaveBeenCalledWith('No booted device')
  })
})
