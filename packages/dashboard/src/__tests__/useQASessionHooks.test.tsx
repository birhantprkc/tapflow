import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { DeviceSummary, Build, BrowserInbound, SessionInfo } from '@/lib/types'

vi.mock('@/lib/queries', () => ({
  getBuild: vi.fn(),
}))

vi.mock('@/hooks/useRelay', () => ({
  useRelay: vi.fn(),
}))

import { getBuild } from '@/lib/queries'
import { useRelay } from '@/hooks/useRelay'
import { useBuildLoader } from '@/hooks/useBuildLoader'
import { useAgentSession } from '@/hooks/useAgentSession'
import { useDeviceSelector } from '@/hooks/useDeviceSelector'

const mockSend = vi.fn()
let capturedOnMessage: (msg: BrowserInbound) => void = () => {}

const makeSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  agentName: 'test-mac',
  // An agent that advertises nothing. `capabilities` is required on the wire, so `[]` — not an
  // absent key — is how the relay reports one that predates a capability (#447).
  capabilities: [],
  devices: [],
  ...overrides,
})

const makeDevice = (overrides: Partial<DeviceSummary> = {}): DeviceSummary => ({
  id: 'avd:Pixel_7',
  name: 'Pixel 7',
  platform: 'android',
  status: 'booted',
  sessionId: 'sess-1',
  busy: false,
  ...overrides,
})

// ─── useBuildLoader ────────────────────────────────────────────────────────────

describe('useBuildLoader', () => {
  beforeEach(() => vi.mocked(getBuild).mockReset())

  it('returns null and does not fetch when buildId is null', () => {
    const { result } = renderHook(() => useBuildLoader(null))
    expect(result.current.build).toBeNull()
    expect(getBuild).not.toHaveBeenCalled()
  })

  it('fetches build and updates state when buildId is provided', async () => {
    const fakeBuild = { id: 42, name: 'MyApp' } as Build
    vi.mocked(getBuild).mockResolvedValue(fakeBuild)

    const { result } = renderHook(() => useBuildLoader('42'))
    await act(async () => {})

    expect(getBuild).toHaveBeenCalledWith('42')
    expect(result.current.build).toBe(fakeBuild)
  })

  it('re-fetches when buildId changes', async () => {
    const build42 = { id: 42, name: 'A' } as Build
    const build99 = { id: 99, name: 'B' } as Build
    vi.mocked(getBuild).mockResolvedValueOnce(build42).mockResolvedValueOnce(build99)

    const { result, rerender } = renderHook(({ id }) => useBuildLoader(id), {
      initialProps: { id: '42' as string | null },
    })
    await act(async () => {})
    expect(result.current.build).toBe(build42)

    rerender({ id: '99' })
    await act(async () => {})
    expect(result.current.build).toBe(build99)
  })
})

// ─── useAgentSession ───────────────────────────────────────────────────────────

describe('useAgentSession', () => {
  beforeEach(() => {
    mockSend.mockReset()
    vi.mocked(useRelay).mockImplementation((onMessage) => {
      capturedOnMessage = onMessage
      return { send: mockSend, connected: false }
    })
  })

  afterEach(() => vi.useRealTimers())

  it('sends agents:list immediately and on interval when connected', () => {
    vi.useFakeTimers()
    vi.mocked(useRelay).mockImplementation((onMessage) => {
      capturedOnMessage = onMessage
      return { send: mockSend, connected: true }
    })

    renderHook(() => useAgentSession('android'))

    expect(mockSend).toHaveBeenCalledWith({ type: 'agents:list' })
    const callCount = mockSend.mock.calls.length

    vi.advanceTimersByTime(5000)
    expect(mockSend.mock.calls.length).toBe(callCount + 1)

    vi.advanceTimersByTime(5000)
    expect(mockSend.mock.calls.length).toBe(callCount + 2)
  })

  it('updates sessions on agents:listed message', async () => {
    const { result } = renderHook(() => useAgentSession('android'))
    const sessions = [makeSession({ agentName: 'mac-1' })]

    act(() => capturedOnMessage({ type: 'agents:listed', sessions }))

    expect(result.current.sessions).toEqual(sessions)
  })

  it('clears booting flag and sets status on session:joined', async () => {
    const { result } = renderHook(() => useAgentSession('android'))

    act(() => {
      result.current.startDevice(makeDevice())
    })
    expect(result.current.booting).toBe(true)

    act(() => capturedOnMessage({ type: 'session:joined', sessionId: 'avd:Pixel_7', capabilities: [] }))
    expect(result.current.booting).toBe(false)
    expect(result.current.status).toBe('Connected')
  })

  // This and the `session:joined` case above call `handleMessage` directly, so they pin the handler's
  // contract and **not** that either message reaches this hook. L5d measured that it does not: `error` and
  // `session:joined` are both sent with `sendTo(ws, …)` to the socket that sent `session:start`, and this
  // hook's socket only ever sends `agents:list` and `device:shutdown`. `inboundDisposition` records that.
  //
  // `sessionId` here is arbitrary — the handler does not read it — and required only because L5d made
  // `error` an addressed reply. That the compiler asked for it at all is what surfaced the reachability
  // question: a fixture had to name a session this socket never joins.
  it('clears booting flag and sets error status on error message', () => {
    const { result } = renderHook(() => useAgentSession('android'))

    act(() => result.current.startDevice(makeDevice()))
    act(() => capturedOnMessage({ type: 'error', sessionId: 'avd:Pixel_7', message: 'boom', reason: 'agent-resources-exhausted' }))

    expect(result.current.booting).toBe(false)
    expect(result.current.status).toBe('Error: boom')
  })

  it('sends device:shutdown and resets state on handleBack', async () => {
    const { result } = renderHook(() => useAgentSession('android'))
    const device = makeDevice({ id: 'avd:Pixel_7', sessionId: 'sess-1' })

    act(() => result.current.startDevice(device))
    // flush ref update effect
    await act(async () => {})

    act(() => result.current.handleBack())

    expect(mockSend).toHaveBeenCalledWith({
      type: 'device:shutdown',
      sessionId: 'sess-1',
      payload: { deviceId: 'avd:Pixel_7' },
    })
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.booting).toBe(false)
    expect(result.current.status).toBe('')
  })

  it('sends device:shutdown and clears selectedAgent on handleBackToMacs', async () => {
    const { result } = renderHook(() => useAgentSession('android'))
    const device = makeDevice({ id: 'avd:Pixel_7', sessionId: 'sess-1' })

    act(() => result.current.setSelectedAgent('mac-1'))
    act(() => result.current.startDevice(device))
    await act(async () => {})

    act(() => result.current.handleBackToMacs())

    expect(mockSend).toHaveBeenCalledWith({
      type: 'device:shutdown',
      sessionId: 'sess-1',
      payload: { deviceId: 'avd:Pixel_7' },
    })
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.selectedAgent).toBeNull()
  })

  it('sends device:shutdown on unmount when a session is active', async () => {
    const { result, unmount } = renderHook(() => useAgentSession('android'))
    const device = makeDevice({ id: 'avd:Pixel_7', sessionId: 'sess-1' })

    act(() => result.current.startDevice(device))
    await act(async () => {})

    unmount()

    expect(mockSend).toHaveBeenCalledWith({
      type: 'device:shutdown',
      sessionId: 'sess-1',
      payload: { deviceId: 'avd:Pixel_7' },
    })
  })
})

// ─── useDeviceSelector ─────────────────────────────────────────────────────────

describe('useDeviceSelector', () => {
  const devices: DeviceSummary[] = [
    makeDevice({ id: 'd1', name: 'Pixel 7', osVersion: 'Android 14', platform: 'android' }),
    makeDevice({ id: 'd2', name: 'Pixel 6', osVersion: 'Android 13', platform: 'android' }),
    makeDevice({ id: 'd3', name: 'iPhone 15', osVersion: 'iOS 17', platform: 'ios' }),
  ]
  /** Advertises nothing, which is what an agent that predates a capability sends (#447). */
  const session: SessionInfo = { agentName: 'mac', capabilities: [], devices }
  const withCaps = (capabilities: string[]): SessionInfo => ({ ...session, capabilities })

  it('filters devices by osVersion when set', () => {
    const { result } = renderHook(() => useDeviceSelector(session, 'android'))

    act(() => result.current.setOsVersion('Android 14'))

    expect(result.current.versionedDevices).toEqual([devices[0]])
  })

  it('filters devices by name search', () => {
    const { result } = renderHook(() => useDeviceSelector(session, 'android'))

    act(() => result.current.setDeviceSearch('Pixel 6'))

    expect(result.current.versionedDevices).toEqual([devices[1]])
  })

  it('returns osVersions sorted descending (newest first)', () => {
    const mixedDevices: DeviceSummary[] = [
      makeDevice({ osVersion: 'Android 13', platform: 'android' }),
      makeDevice({ osVersion: 'Android 15', platform: 'android' }),
      makeDevice({ osVersion: 'Android 14', platform: 'android' }),
    ]
    const sess: SessionInfo = { agentName: 'mac', capabilities: [], devices: mixedDevices }
    const { result } = renderHook(() => useDeviceSelector(sess, 'android'))

    expect(result.current.osVersions).toEqual(['Android 15', 'Android 14', 'Android 13'])
  })

  // #439: leaving a session is a conditional re-render, not an unmount, so an armed toggle used to
  // survive back-to-the-list and erase the next device the tester picked.
  describe('resetMode is a one-shot intent', () => {
    it('hands the armed mode to the viewer and disarms the toggle when a device is picked', () => {
      const { result } = renderHook(() => useDeviceSelector(withCaps(['full-reset']), 'ios'))

      act(() => result.current.setResetMode('full-erase'))
      act(() => result.current.consumeResetMode())

      expect(result.current.appliedResetMode).toBe('full-erase')
      expect(result.current.resetMode).toBe('app-only')
    })

    it('does not re-arm on the next pick', () => {
      const { result } = renderHook(() => useDeviceSelector(withCaps(['full-reset']), 'ios'))

      act(() => result.current.setResetMode('full-erase'))
      act(() => result.current.consumeResetMode())
      act(() => result.current.consumeResetMode())

      expect(result.current.appliedResetMode).toBe('app-only')
      expect(result.current.resetMode).toBe('app-only')
    })

    // #447: arming a mode nothing acts on would disarm the toggle having erased nothing — a
    // stronger promise than before, kept even less.
    // `'ios'` on purpose: the platform is no longer what decides this, so the test that proves the
    // mode is not applied has to be one the old platform check would have got wrong.
    it('never applies full-erase when the agent does not advertise it', () => {
      const { result } = renderHook(() => useDeviceSelector(session, 'ios'))

      expect(result.current.fullResetSupported).toBe(false)

      act(() => result.current.setResetMode('full-erase'))
      act(() => result.current.consumeResetMode())

      expect(result.current.appliedResetMode).toBe('app-only')
    })
  })

  // #447: this used to be `os !== 'android'`, which says "Android cannot" when what it means is
  // "this agent did not say it can". The two differ in both directions, and each direction is a
  // bug the platform string cannot express.
  describe('Full reset is gated on the capability, not the platform', () => {
    it('is supported when the agent advertises full-reset', () => {
      const { result } = renderHook(() => useDeviceSelector(withCaps(['clipboard', 'full-reset']), 'ios'))
      expect(result.current.fullResetSupported).toBe(true)
    })

    // The direction the OS string got wrong first: an agent too old to implement Full reset still
    // reports `platform: 'ios'`, so the viewer offered a control that agent has no code for.
    it('is not supported on iOS when the agent is too old to advertise it', () => {
      const { result } = renderHook(() => useDeviceSelector(withCaps([]), 'ios'))
      expect(result.current.fullResetSupported).toBe(false)
    })

    // And the other direction, which is what unblocks the rest of #447: the moment AndroidAgent
    // implements `-wipe-data` and advertises it, the toggle appears with no dashboard change.
    it('is supported on Android once that agent advertises it', () => {
      const { result } = renderHook(() => useDeviceSelector(withCaps(['full-reset']), 'android'))
      expect(result.current.fullResetSupported).toBe(true)
    })

    // Nothing picked yet means nothing known yet. Hiding the control is the safe answer; showing it
    // would arm a one-shot intent against an agent we have not heard from.
    it('is not supported before an agent is selected', () => {
      const { result } = renderHook(() => useDeviceSelector(undefined, 'ios'))
      expect(result.current.fullResetSupported).toBe(false)
    })

    // What `AndroidAgent` actually registers today. Named on its own because the shapes around it
    // are `[]` and `['clipboard','full-reset']`, and a guard written as "has any capability at all"
    // passes both of those — this is the case that tells membership from non-emptiness.
    it('is not supported for an agent that advertises other capabilities but not this one', () => {
      const { result } = renderHook(() => useDeviceSelector(withCaps(['clipboard']), 'android'))
      expect(result.current.fullResetSupported).toBe(false)
    })

    // The gate used to read `os`, which cannot change while the page lives, so `consumeResetMode`'s
    // dependency on it never had to be right. It reads the picked agent now, and that *does* change
    // under a live hook: leaving a session is a conditional re-render, not an unmount (#439), and
    // going back to the Mac list without picking a device leaves the toggle armed.
    //
    // Without `fullResetSupported` in the callback's deps this test fails and every other one here
    // still passes — they each render against a single fixed session, so the stale closure never
    // gets a chance to be wrong.
    it('re-reads the guard when the picked agent changes, so an armed toggle cannot cross over', () => {
      const { result, rerender } = renderHook(
        ({ s }: { s: SessionInfo }) => useDeviceSelector(s, 'ios'),
        { initialProps: { s: withCaps(['full-reset']) } },
      )

      act(() => result.current.setResetMode('full-erase'))
      rerender({ s: withCaps(['clipboard']) })      // different Mac, no device picked in between
      act(() => result.current.consumeResetMode())

      expect(result.current.appliedResetMode).toBe('app-only')
    })
  })
})
