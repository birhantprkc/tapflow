// The reboot sequence: shut the device down, and boot it only when *this* shutdown is answered.
//
// **The whole hook is about the id comparison.** `device:boot` on a running device does nothing, so a
// reboot has to be two messages — and the first of them is a message this app already sends three
// other times, uncorrelated, on the way out of a view (`useAgentSession`). A reply to one of those
// reaching here uncompared boots a device somebody deliberately shut down.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { BrowserToRelay } from '@tapflowio/protocol'
import {
  useDeviceReboot, REBOOT_SHUTDOWN_DEADLINE_MS,
  type RebootMessage, type RebootMessageHandler,
} from '@/hooks/useDeviceReboot'

type Sent = Extract<BrowserToRelay, { type: 'device:shutdown' }>

afterEach(() => { vi.useRealTimers() })

function setup(opts: { sessionId?: string } = {}) {
  const sent: Sent[] = []
  const errors: string[] = []
  const booted: number[] = []
  const handlerRef = { current: undefined as RebootMessageHandler | undefined }

  const view = renderHook(
    (props: { sessionId: string; deviceReady: boolean }) => useDeviceReboot({
      sessionId: props.sessionId,
      deviceId: 'DEVICE-1',
      deviceReady: props.deviceReady,
      send: (m) => { if (m.type === 'device:shutdown') sent.push(m as Sent) },
      handlerRef,
      onShutdownComplete: () => { booted.push(1) },
      onError: (m) => errors.push(m),
    }),
    { initialProps: { sessionId: opts.sessionId ?? 's1', deviceReady: true } },
  )

  /** The id of the shutdown this hook most recently sent. */
  const lastId = () => sent.at(-1)?.requestId
  const deliver = (msg: RebootMessage) => act(() => { handlerRef.current?.(msg) })
  const done = (requestId: string | undefined) => deliver({
    type: 'device:shutdown-done', sessionId: 's1', requestId, payload: { deviceId: 'DEVICE-1' },
  } as RebootMessage)

  return { view, sent, errors, booted, lastId, deliver, done }
}

describe('useDeviceReboot', () => {
  it('sends one correlated shutdown when asked', () => {
    const { view, sent } = setup()
    act(() => { view.result.current.reboot() })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'device:shutdown', sessionId: 's1', payload: { deviceId: 'DEVICE-1' } })
    // The correlator is the feature, so it is asserted as present and non-empty rather than assumed.
    expect(sent[0].requestId, 'the shutdown went out uncorrelated').toBeTruthy()
    expect(view.result.current.pending).toBe(true)
  })

  it('boots the device when its own shutdown is answered', () => {
    const { view, booted, lastId, done } = setup()
    act(() => { view.result.current.reboot() })
    done(lastId())
    expect(booted).toHaveLength(1)
    expect(view.result.current.pending, 'the control stayed busy after the sequence handed off').toBe(false)
  })

  it('does not boot on an answer to somebody else\'s shutdown', () => {
    // **The case this hook exists to get right.** `SessionList`'s teardown shutdowns are answered on
    // the same session, and the relay forwards agent replies to whichever socket holds it now.
    const { view, booted, done } = setup()
    act(() => { view.result.current.reboot() })
    done('a-different-request')
    expect(booted, 'a stranger\'s shutdown booted this device').toHaveLength(0)
    expect(view.result.current.pending, 'the wait was cleared by a reply that answered nothing').toBe(true)
  })

  it('does not boot on an uncorrelated shutdown-done', () => {
    // The exact shape `useAgentSession` produces — three sends with no `requestId`, on purpose — and
    // the shape the relay's own idle timer produces. `undefined === undefined` would match here if the
    // comparison were written as an equality alone, which is why the absent case has its own test.
    const { view, booted, done } = setup()
    act(() => { view.result.current.reboot() })
    done(undefined)
    expect(booted, 'an id-less teardown reply booted the device').toHaveLength(0)
    expect(view.result.current.pending).toBe(true)
  })

  it('reports a refused shutdown and boots nothing', () => {
    const { view, booted, errors, lastId, deliver } = setup()
    act(() => { view.result.current.reboot() })
    deliver({ type: 'device:shutdown-error', sessionId: 's1', requestId: lastId(), message: 'agent offline' } as RebootMessage)
    expect(booted, 'a device that was never shut down was booted').toHaveLength(0)
    expect(errors).toHaveLength(1)
    // The relay's sentence is passed through: it is the only thing that says *why*, and the control
    // it came from goes back to looking exactly as it did.
    expect(errors[0]).toContain('agent offline')
    expect(view.result.current.pending).toBe(false)
  })

  it('gives up when neither reply arrives', () => {
    // Silence is a reachable answer, not a hang: both agents open `handleDeviceShutdown` with
    // `if (!state) return`, and `DeviceShutdownError` is declared `RelayToBrowser` so no agent can
    // send one. Without this the control spins for the rest of the session.
    vi.useFakeTimers()
    const { view, booted, errors } = setup()
    act(() => { view.result.current.reboot() })
    act(() => { vi.advanceTimersByTime(REBOOT_SHUTDOWN_DEADLINE_MS + 1) })
    expect(view.result.current.pending).toBe(false)
    expect(booted, 'the deadline booted a device instead of ending the wait').toHaveLength(0)
    expect(errors).toHaveLength(1)
  })

  it('does not fire the deadline after the shutdown landed', () => {
    // **The control for the test above.** Without it that one passes on a hook that always reports a
    // failure at the deadline, including over a reboot that worked.
    vi.useFakeTimers()
    const { view, booted, errors, lastId, done } = setup()
    act(() => { view.result.current.reboot() })
    done(lastId())
    act(() => { vi.advanceTimersByTime(REBOOT_SHUTDOWN_DEADLINE_MS + 1) })
    expect(booted).toHaveLength(1)
    expect(errors, 'a completed reboot was reported as unanswered').toHaveLength(0)
  })

  it('still restarts when the answer arrives after the deadline', () => {
    // **A late answer is not a stalled restart — it is a device left off.** The agent tears its
    // streamer down before it awaits the shutdown, and the relay says nothing when that socket
    // closes, so `deviceReady` stays true and the canvas keeps its last frame: nothing in the app
    // would boot the device again, and the toast said it was probably still running.
    vi.useFakeTimers()
    const { view, booted, lastId, done } = setup()
    act(() => { view.result.current.reboot() })
    const id = lastId()
    act(() => { vi.advanceTimersByTime(REBOOT_SHUTDOWN_DEADLINE_MS + 1) })
    expect(view.result.current.pending, 'the control stayed locked past the deadline').toBe(false)

    done(id)
    expect(booted, 'the late answer was dropped and the device left off').toHaveLength(1)
  })

  it('gives up the sequence when something else takes the device', () => {
    // Readiness drops on all three signals that invalidate a shutdown — agent-away, a reconnect's
    // re-join, and a rebind, which boots the device itself. Without this the control came back from a
    // *successful* rebind still spinning, and then reported a failure for a restart that had worked.
    vi.useFakeTimers()
    const { view, booted, errors, lastId, done } = setup()
    act(() => { view.result.current.reboot() })
    const id = lastId()
    act(() => { view.rerender({ sessionId: 's1', deviceReady: false }) })
    expect(view.result.current.pending, 'the control stayed busy after the device went away').toBe(false)

    done(id)
    expect(booted, 'a device somebody else was already booting got booted again').toHaveLength(0)
    act(() => { vi.advanceTimersByTime(REBOOT_SHUTDOWN_DEADLINE_MS + 1) })
    expect(errors, 'a restart that was superseded was reported as failed').toHaveLength(0)
  })

  it('ignores a second press while the first is still running', () => {
    const { view, sent } = setup()
    act(() => { view.result.current.reboot() })
    act(() => { view.result.current.reboot() })
    expect(sent, 'a second shutdown went out for a device already shutting down').toHaveLength(1)
  })

  it('drops an in-flight reboot when the session changes', () => {
    // A different session is a different device. The old one's reply must not boot the new one, and
    // the control must not arrive busy.
    const { view, booted, lastId, done } = setup()
    act(() => { view.result.current.reboot() })
    const stale = lastId()
    act(() => { view.rerender({ sessionId: 's2', deviceReady: true }) })
    expect(view.result.current.pending, 'the new session inherited a wait').toBe(false)
    done(stale)
    expect(booted, 'the previous session\'s shutdown booted this session\'s device').toHaveLength(0)
  })
})
