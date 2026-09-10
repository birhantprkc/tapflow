// The iOS viewer wires `useDecoderStream.onUnsupported` into local state so the shared
// `SimulatorInfoCard` can carry the unsupported message (#748). Before the fix the callback was a
// no-op, the iOS viewer never told the card anything, and the same browser condition that Android
// caught silently rendered nothing on iOS.
//
// This file drives the **real path** through `DeviceViewer` for the same reason `network.test.tsx`
// and `openUrl.test.tsx` do: the prop wiring, the decoder hook, the state, and the shared status
// component are four separate layers, and a unit test on `SimulatorInfoCard` alone would not say
// the chain is intact.
//
// **Mutation:** replacing the iOS `onUnsupported` callback with a no-op must fail this test —
// `decode` would still flip the relay's channel state, but the `role="status"` region would never
// show the unsupported sentence. Verified by hand below.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { BrowserInbound } from '@/lib/types'

const send = vi.fn()
let deliver: ((msg: BrowserInbound) => void) | null = null
let deliverBinary: ((data: ArrayBuffer) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void, onBinaryFrame?: (data: ArrayBuffer) => void) => {
    deliver = onMessage
    deliverBinary = onBinaryFrame ?? null
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
// The harness forces the decoder selection to fail (`pickDecoder() -> null`). The existing
// `DeviceViewer.network.test.tsx` only mocks `canDecodeH264`; mocking `pickDecoder` is what makes
// `ensureDecoder()` reach its `onUnsupported()` branch — `canDecodeH264` alone has no effect on the
// decode path, only on the agent's H.264 negotiation at boot.
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  pickDecoder: () => null,
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

// An iOS-shaped chrome — `framePng` is the discriminator `DeviceViewer` uses to pick `IOSViewer`.
const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

/** Brings the viewer to "iOS on screen": joined, ready, chrome arrived. */
function live(sessionId = 'mine') {
  render(<DeviceViewer sessionId={sessionId} deviceId="dev-1" />)
  act(() => { deliver!({ type: 'session:joined', sessionId, capabilities: [] }) })
  act(() => { deliver!({ type: 'device:ready', sessionId, payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId, payload: CHROME }) })
}

describe('DeviceViewer — iOS decoder-unsupported status reaches the shared card (#748)', () => {
  beforeEach(() => {
    send.mockClear()
    deliver = null
    deliverBinary = null
  })

  it('surfaces "Streaming is not supported in this environment." in the shared role="status" region when pickDecoder returns null', () => {
    // **Mutation:** reverting `onUnsupported: () => setDecoderUnsupported(true)` in `IOSViewer.tsx`
    // back to a no-op must fail this test — the `pickDecoder() -> null` callback would still fire,
    // but the iOS viewer would never propagate it and the shared card would never show the sentence.
    live()

    // Pre-condition — the persistent region is mounted and empty (no status yet). The viewer renders
    // multiple `role="status"` live regions (keyboard toggle, restart, record, network, and the
    // shared SimulatorInfoCard status). The SimulatorInfoCard region is the only one that is a
    // `<div>`; the toolbar's live regions are all `<span>` siblings of their controls.
    const divStatus = (): HTMLElement => {
      const match = screen.getAllByRole('status').find((el) => el.tagName === 'DIV')
      expect(match, 'the shared SimulatorInfoCard status region is missing').toBeTruthy()
      return match as HTMLElement
    }
    const regionBefore = divStatus()
    expect(regionBefore.textContent).toBe('')

    // Trigger the decoder path. A minimal envelope that the relay's parseEnvelopeHeader recognises
    // as an H.264 frame is enough: ensureDecoder() runs before the keyframe check, so the
    // pickDecoder() -> null callback fires on the very first frame.
    const envelope = (() => {
      const buf = new ArrayBuffer(22)
      const view = new DataView(buf)
      view.setUint8(0, 0x54); view.setUint8(1, 0x46); view.setUint8(2, 0x46); view.setUint8(3, 0x45)
      view.setUint8(4, 1)        // SUPPORTED_VERSION
      view.setUint8(5, 0x01)     // FLAG_H264 (no keyframe, no audio) — keyframe is not required
      // capturedAt / relayedAt left as 0
      return buf
    })()
    expect(deliverBinary, 'useRelay did not register a binary-frame callback').toBeTypeOf('function')
    act(() => { deliverBinary!(envelope) })

    expect(regionBefore.textContent).toBe('Streaming is not supported in this environment.')
  })
})
