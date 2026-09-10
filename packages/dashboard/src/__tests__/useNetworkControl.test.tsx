import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { NetworkStatePayload } from '@tapflowio/protocol'
import {
  useNetworkControl, NETWORK_REPORT_DEADLINE_MS, NETWORK_REQUEST_DEADLINE_MS,
  type NetworkMessage, type NetworkMessageHandler,
} from '@/hooks/useNetworkControl'

type Sent = { type: string; requestId?: string; sessionId?: string; payload?: { offline: boolean } }

function setup(opts: { supported?: boolean; deviceReady?: boolean; sessionId?: string } = {}) {
  const sent: Sent[] = []
  const errors: string[] = []
  const handlerRef = { current: undefined as NetworkMessageHandler | undefined }

  const view = renderHook(
    (props: { sessionId: string; deviceReady: boolean }) => useNetworkControl({
      sessionId: props.sessionId,
      send: (m) => sent.push(m as Sent),
      supported: opts.supported ?? true,
      deviceReady: props.deviceReady,
      handlerRef,
      onError: (m) => errors.push(m),
    }),
    { initialProps: { sessionId: opts.sessionId ?? 's1', deviceReady: opts.deviceReady ?? true } },
  )

  /** A report the agent sends unasked — no correlator, which is what makes it a report. */
  const report = (payload: NetworkStatePayload, sessionId = 's1') =>
    act(() => { handlerRef.current?.({ type: 'network:state', sessionId, payload } as NetworkMessage) })

  /** The answer to the most recent request this hook sent. */
  const answer = (payload: NetworkStatePayload) => {
    const req = [...sent].reverse().find((s) => s.type === 'network:set')
    act(() => {
      handlerRef.current?.({
        type: 'network:state', sessionId: 's1', requestId: req?.requestId, payload,
      } as NetworkMessage)
    })
  }

  const fail = (message = 'No booted device') => {
    const req = [...sent].reverse().find((s) => s.type === 'network:set')
    act(() => {
      handlerRef.current?.({
        type: 'network:error', sessionId: 's1', requestId: req?.requestId ?? 'none', message,
      } as NetworkMessage)
    })
  }

  return { sent, errors, handlerRef, view, report, answer, fail }
}

const steerable = (offline: boolean): NetworkStatePayload => ({ offline, available: true })
const unsteerable = (offline: boolean): NetworkStatePayload =>
  ({ offline, available: false, reason: 'unsupported-device' })

describe('useNetworkControl', () => {
  afterEach(() => { vi.useRealTimers() })

  it('registers itself only when the agent says it can do this', () => {
    // The control the capability gate needs. Without it the assertions below pass on a hook that
    // registers unconditionally, and `DeviceViewer` would then route a frame into a viewer whose
    // agent never produces one.
    //
    // Mutation: dropping the `if (!supported) return` guard leaves a handler here.
    const { handlerRef } = setup({ supported: false })
    expect(handlerRef.current).toBe(undefined)
  })

  it('registers when it can', () => {
    const { handlerRef } = setup()
    expect(handlerRef.current).toBeTypeOf('function')
  })

  it('starts out waiting, which is not a position', () => {
    const { view } = setup()
    expect(view.result.current.position).toBe('waiting')
  })

  it('takes the position the report gives it', () => {
    const { view, report } = setup()
    report(steerable(true))
    expect(view.result.current.position).toBe('offline')
    report(steerable(false))
    expect(view.result.current.position).toBe('online')
  })

  it('keeps the position when tapflow can no longer change it', () => {
    // **`available: false` means "cannot change it", not "cannot read it".** The protocol says so —
    // `NetworkNotSteerable` is *"whatever the device's network is doing, tapflow can no longer change
    // it"* — and carries `offline` on that member so the viewer can still draw where the device is.
    //
    // An earlier version of this test asserted `unknown` here, which is what let the ratchet ship:
    // from a position-less rendering `toggle` asked for offline every time, so a device taken offline
    // on an unconfirmed write could not be brought back. The mutation that would have caught it died
    // against a test encoding the same mistake.
    const { view, report } = setup()
    report(unsteerable(true))
    expect(view.result.current.position).toBe('offline')
    expect(view.result.current.steerable).toBe(false)

    report(unsteerable(false))
    expect(view.result.current.position).toBe('online')
  })

  it('asks for online from a position it cannot steer, not offline again', () => {
    // The ratchet itself. Without the line above this asked `offline: true` forever.
    //
    // Mutation: folding `available: false` into a position-less state fails here.
    const { view, sent, report } = setup()
    report(unsteerable(true))
    act(() => { view.result.current.toggle() })
    expect(sent.at(-1)).toMatchObject({ payload: { offline: false } })
  })

  it('says it can steer again once a steerable report arrives', () => {
    const { view, report } = setup()
    report(unsteerable(true))
    expect(view.result.current.steerable).toBe(false)
    report(steerable(true))
    expect(view.result.current.steerable).toBe(true)
  })

  it('draws the same position whatever reason it is given', () => {
    // **The control for #618.** Every read failure currently arrives as `unsupported-device`, so a
    // *position* that varied by reason would be varying by a value that carries no information yet —
    // and would tell a tester "this device will never do it" about one that is rebooting.
    //
    // **This used to say "branching on `reason` anywhere in the hook fails here", and that was false
    // the moment the hook began reading `awaiting-app`** — it asserts `position`, which no reason has
    // ever moved. A comment claiming a mutation is caught reads as though the mutation was tried; the
    // one below is the assertion that actually holds a reason branch.
    //
    // Mutation: making `position` depend on `reason` fails here.
    const { view, report } = setup()
    report(unsteerable(false))
    const first = view.result.current.position
    report({ offline: false, available: false, reason: 'not-armed' })
    expect(view.result.current.position).toBe(first)
    report({ offline: false, available: false, reason: 'hooks-not-installed' })
    expect(view.result.current.position).toBe(first)
  })

  it('carries every reason through, not just the one it used to trust', () => {
    // This used to assert the opposite — that `awaiting-app` was kept and the rest dropped — and the
    // reason it did was about the wire: every Android read failure arrived as `unsupported-device`,
    // so naming a reason meant telling a tester "this will never work" about a rebooting device. The
    // set has been split (#618), so each member now carries a remedy that differs and dropping them
    // throws away the difference.
    //
    // Still asserted member by member rather than in one pass: a hook that passed only the first
    // reason it saw, or one that cached, reads the same on a single sample.
    const { view, report } = setup()

    for (const reason of ['awaiting-app', 'not-armed', 'hooks-not-installed', 'unsupported-device',
      'state-unconfirmed', 'filter-unavailable'] as const) {
      report({ offline: false, available: false, reason })
      expect(view.result.current.reason, `reason ${reason}`).toBe(reason)
    }

    // And a steerable report clears it, so a device that launches its app stops being drawn as
    // waiting for one.
    report(steerable(false))
    expect(view.result.current.reason).toBeUndefined()
  })

  it('announces enforcement that stopped, and announces it once', () => {
    // **The one reason that interrupts rather than re-colours.** It says a device that was offline
    // stopped being enforced, so requests the tester believed were blocked had been succeeding — a
    // test already signed off, invalidated. Every other member changes what the control looks like.
    //
    // Once, though: a re-join asks for the state again and the answer still carries the reason, so an
    // announcement per report would fire every time a viewer reconnects.
    const { report, errors } = setup()

    report({ offline: false, available: false, reason: 'enforcement-lost' })
    report({ offline: false, available: false, reason: 'enforcement-lost' })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/needs checking again/)

    // And it can be announced again once something else has been said in between — a second loss is
    // a second invalidated test.
    report(steerable(false))
    report({ offline: false, available: false, reason: 'enforcement-lost' })
    expect(errors).toHaveLength(2)
  })

  it('does not move the toggle when the click is sent', () => {
    // **No optimistic render.** The position is what the device last said, and a click is a request,
    // not an answer — a device that refuses or fails to change would otherwise be drawn where the
    // tester asked it to be rather than where it is.
    //
    // Mutation: a `setPosition` in `toggle` fails here.
    const { view, sent } = setup()
    act(() => { view.result.current.toggle() })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'network:set', sessionId: 's1', payload: { offline: true } })
    expect(view.result.current.position).toBe('waiting')
    expect(view.result.current.pending).toBe(true)
  })

  it('moves only once the answer arrives, and stops waiting', () => {
    const { view, answer } = setup()
    act(() => { view.result.current.toggle() })
    answer(steerable(true))

    expect(view.result.current.position).toBe('offline')
    expect(view.result.current.pending).toBe(false)
  })

  it('asks for the opposite of where the device is', () => {
    const { view, sent, report } = setup()
    report(steerable(true))
    act(() => { view.result.current.toggle() })
    expect(sent.at(-1)).toMatchObject({ payload: { offline: false } })
  })

  it('asks to go offline when nothing has been reported', () => {
    // What keeps the control usable rather than merely visible: a click is the only thing that
    // produces a fresh `network:state`, so a session with no report has exactly one way out. Offline
    // is also the direction a tester came here for.
    const { view, sent } = setup()
    act(() => { view.result.current.toggle() })
    expect(sent.at(-1)).toMatchObject({ payload: { offline: true } })
  })

  it('sends one request per click, not one per press', () => {
    // The `pending` guard, which nothing reached: a second request would overwrite `requestId`, so an
    // answer to the first would match nothing and `pending` would stay true for the session.
    //
    // Mutation: dropping `|| pending` fails here.
    const { view, sent } = setup()
    act(() => { view.result.current.toggle() })
    act(() => { view.result.current.toggle() })
    expect(sent).toHaveLength(1)
  })

  it('sends nothing at all when the agent cannot do this', () => {
    // The toolbar hides the button today, so this guard is reached by nothing — which is the reason
    // to pin it rather than to leave it out: the hook is the thing that must not send.
    const { view, sent } = setup({ supported: false })
    act(() => { view.result.current.toggle() })
    expect(sent).toEqual([])
  })

  it('clears the wait on an error without claiming the device moved', () => {
    // `network:error` says the request never reached a device — so it says nothing about where that
    // device is, and the position must survive it untouched.
    const { view, report, fail } = setup()
    report(steerable(true))
    act(() => { view.result.current.toggle() })
    fail()

    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.position).toBe('offline')
  })

  it('says so when the request could not be dispatched', () => {
    // Nothing renders a `network:error` otherwise: the position is unchanged, the spinner stops, and a
    // click that changes nothing is indistinguishable from a dead button. `toast.error` renders with
    // `role="alert"`, so this is also the only thing a screen reader hears.
    //
    // Mutation: dropping the `onError` call leaves this empty.
    const { view, errors, fail } = setup()
    act(() => { view.result.current.toggle() })
    fail('No booted device — boot one before changing its network.')
    expect(errors).toEqual(['No booted device — boot one before changing its network.'])
  })

  it('says nothing about an error meant for somebody else', () => {
    // The correlator gate applies to the toast too, or a stale failure from a request this control
    // already replaced would surface as a fresh one.
    const { view, errors, handlerRef, fail } = setup()
    act(() => { view.result.current.toggle() })
    act(() => {
      handlerRef.current?.({
        type: 'network:error', sessionId: 's1', requestId: 'someone-else', message: 'not mine',
      } as NetworkMessage)
    })
    expect(errors).toEqual([])
    expect(view.result.current.pending).toBe(true)
    // …and the handler was live all along, which neither assertion above can show: `pending` is what
    // `toggle` set, and an absent handler swallows the frame just as quietly as a rejected one does.
    fail('the real one')
    expect(errors).toEqual(['the real one'])
  })

  it('gives the control back when a request goes unanswered', () => {
    // **Nothing else ever would.** `send` drops the frame outright when the socket is not open — no
    // queue, no throw — and an agent that receives it and then dies is answered by nobody, since the
    // relay only produces `network:error` for what *it* could not dispatch. `pending` would then stay
    // true for the life of the session: a spinner that never stops, and a button whose every click
    // the guard swallows. `useClipboardBridge` arms the same kind of budget per request.
    //
    // Mutation: removing the request deadline leaves `pending` true here.
    vi.useFakeTimers()
    const { view, errors } = setup()
    act(() => { view.result.current.toggle() })
    expect(view.result.current.pending).toBe(true)

    act(() => { vi.advanceTimersByTime(NETWORK_REQUEST_DEADLINE_MS + 1) })
    expect(view.result.current.pending).toBe(false)
    expect(errors).toHaveLength(1)
    // …and the request's own silence moved nothing: the position here is `unknown` because the
    // *report* deadline, a separate and shorter one, ran out on the way. An unanswered request says
    // nothing about where the device is, and the two deadlines answer different questions.
    expect(view.result.current.position).toBe('unknown')
  })

  it('does not give up on a request that was answered in time', () => {
    // The control for the deadline above. Without it that assertion passes on a hook that clears
    // `pending` on a timer regardless — which would fire an error toast after every successful click.
    vi.useFakeTimers()
    const { view, errors, answer } = setup()
    act(() => { view.result.current.toggle() })
    act(() => { vi.advanceTimersByTime(NETWORK_REQUEST_DEADLINE_MS - 100) })
    answer(steerable(true))
    act(() => { vi.advanceTimersByTime(NETWORK_REQUEST_DEADLINE_MS * 2) })

    expect(errors).toEqual([])
    expect(view.result.current.position).toBe('offline')
    expect(view.result.current.pending).toBe(false)
  })

  it('ignores an answer correlated to a request it did not make', () => {
    const { view, handlerRef } = setup()
    act(() => { view.result.current.toggle() })
    act(() => {
      handlerRef.current?.({
        type: 'network:state', sessionId: 's1', requestId: 'someone-else', payload: steerable(true),
      } as NetworkMessage)
    })
    // The state still applies — it is the device's, whoever asked — but the wait is not this one's
    // to clear, or a slow reply would arrive to a control that had already re-armed.
    expect(view.result.current.position).toBe('offline')
    expect(view.result.current.pending).toBe(true)
  })

  it('rejects the answer to a request the device disappeared during, once it is back', () => {
    // **The window the readiness guard does not cover.** It drops what arrives *while* the device is
    // away; this is the reply that arrives after it returns, produced before the reboot and
    // correlated to a request this hook already told the tester it had given up on.
    //
    // Applying it would be the defect this whole hook was changed to end, one transition later: the
    // pre-reboot position back on screen, and the report deadline frozen with it, because that
    // deadline only runs while `position === 'waiting'`.
    const { view, handlerRef, sent } = setup()
    act(() => { view.result.current.toggle() })
    const req = sent.find((m) => m.type === 'network:set')?.requestId

    act(() => { view.rerender({ sessionId: 's1', deviceReady: false }) })
    act(() => { view.rerender({ sessionId: 's1', deviceReady: true }) })
    expect(view.result.current.position, 'the reboot left it waiting for a fresh report').toBe('waiting')

    act(() => {
      handlerRef.current?.({
        type: 'network:state', sessionId: 's1', requestId: req, payload: steerable(true),
      } as NetworkMessage)
    })
    expect(view.result.current.position, 'a pre-reboot answer was applied after the reboot').toBe('waiting')
  })

  it('starts rejecting nothing in a new session', () => {
    // The abandoned set is per session. Left uncleared it only ever grows, and an id reused across
    // sessions — which nothing forbids — would be refused for a request that was never dropped.
    const { view, handlerRef, sent } = setup()
    act(() => { view.result.current.toggle() })
    const req = sent.find((m) => m.type === 'network:set')?.requestId
    act(() => { view.rerender({ sessionId: 's1', deviceReady: false }) })
    act(() => { view.rerender({ sessionId: 's2', deviceReady: true }) })

    act(() => {
      handlerRef.current?.({
        type: 'network:state', sessionId: 's2', requestId: req, payload: steerable(true),
      } as NetworkMessage)
    })
    expect(view.result.current.position, 'the new session inherited a refusal').toBe('offline')
  })

  it('settles on unknown when no report arrives before the deadline', () => {
    vi.useFakeTimers()
    const { view } = setup()
    expect(view.result.current.position).toBe('waiting')

    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS + 1) })
    expect(view.result.current.position).toBe('unknown')
  })

  it('does not settle when a report arrives in time', () => {
    // **The control for the deadline.** Without it the assertion above passes on a hook that settles
    // on `unknown` unconditionally, which would overwrite a device that had just answered.
    //
    // Mutation: removing the `clearTimeout` teardown, or the `position !== 'waiting'` guard, fails here.
    vi.useFakeTimers()
    const { view, report } = setup()
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS - 50) })
    report(steerable(false))
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS) })

    expect(view.result.current.position).toBe('online')
  })

  it('does not arm the deadline before the device is ready', () => {
    // A session with no device has nothing to report, so calling its silence unreadable would be a
    // verdict on a question nobody asked.
    vi.useFakeTimers()
    const { view } = setup({ deviceReady: false })
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS * 3) })
    expect(view.result.current.position).toBe('waiting')

    view.rerender({ sessionId: 's1', deviceReady: true })
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS + 1) })
    expect(view.result.current.position).toBe('unknown')
  })

  it('forgets the position when the device stops being ready', () => {
    // A reboot keeps the session id, so the reset below never fired for it. The agent's boot path
    // clears airplane mode and reports online — so an amber "offline" sat over a device being reset
    // to the opposite, for the 30–60s the boot takes.
    const { view, report } = setup()
    report(steerable(true))
    expect(view.result.current.position).toBe('offline')

    view.rerender({ sessionId: 's1', deviceReady: false })
    // `unknown`, not `waiting`: this device has been here, so "no state has been reported" is the true
    // and terminal thing to say. `waiting` would draw a pulse and claim a read is under way while the
    // deadline that ends that claim is gated on readiness — nothing checking, and nothing to stop it.
    expect(view.result.current.position, 'the pre-reboot position survived the reboot').toBe('unknown')
  })

  it('does not carry "this one has been here" into the next session', () => {
    // The memory is per session: switching to a session whose device has not arrived yet must read as
    // waiting, not as a device that came and went. Otherwise the first thing a tester sees on a new
    // session is a verdict about a device they have not been shown.
    // Both change together, which is what a session switch looks like: the new session has no device
    // on screen yet. Changing only the id leaves the readiness effect unrun, so it would not have
    // exercised the memory at all — the first version of this test did exactly that and passed with
    // the reset deleted.
    const { view } = setup()
    expect(view.result.current.position).toBe('waiting')

    view.rerender({ sessionId: 's2', deviceReady: false })
    expect(view.result.current.position, 'the previous session\'s device leaked into this one').toBe('waiting')
  })

  it('remembers a device across a switch between two sessions that both have one', () => {
    // **The one switch that never passes through an unready device.** The test above changes the id
    // and the readiness together, which is what a switch usually looks like; this is the switch where
    // `deviceReady` stays `true` the whole way, so the readiness effect never reruns and the session
    // reset is the only thing that touches the memory.
    //
    // Getting it wrong here is not a cosmetic difference. `waiting` draws "Checking the network
    // state." and its deadline is gated on readiness, so with the device gone nothing arms and
    // nothing ends the claim — the exact forever-pulse this hook was changed to remove.
    const { view } = setup()
    view.rerender({ sessionId: 's2', deviceReady: true })
    view.rerender({ sessionId: 's2', deviceReady: false })
    expect(view.result.current.position, 'a device that had been here read as one that never was')
      .toBe('unknown')
  })

  it('stops claiming the device cannot be steered once it is gone', () => {
    // `steerable` is a claim about the device, like the position, and the readiness reset dropped
    // every other one. Left behind it disabled the control while `reason` — the thing that explains
    // the disabling — was cleared in the same breath, so what stayed on screen was a dead button with
    // nothing to say. A `session:rebound` can also put a different device on the far side of this.
    const { view, report } = setup()
    report(unsteerable(false))
    expect(view.result.current.steerable).toBe(false)

    view.rerender({ sessionId: 's1', deviceReady: false })
    expect(view.result.current.steerable, 'the departed device still said it could not be steered')
      .toBe(true)
    expect(view.result.current.reason).toBeUndefined()
  })

  it('still waits, rather than reporting unknown, before the session has ever had a device', () => {
    // The other half of the same distinction. A session with no device yet has nothing to report and
    // nobody has asked, so calling that silence unreadable is a verdict on a question nobody put.
    const { view } = setup({ deviceReady: false })
    expect(view.result.current.position).toBe('waiting')
  })

  it('drops a report that was already on its way when the device stopped being ready', () => {
    // The reset clears the position and the in-flight request, but the answer to that request can
    // still land. Applying it puts the pre-reboot position back — and because the deadline is gated
    // on `position === 'waiting'`, the wait then never resolves to `unknown` either. The stale answer
    // this hook was changed to end, restored by the change itself.
    const { view, report } = setup()
    report(steerable(true))
    expect(view.result.current.position).toBe('offline')

    view.rerender({ sessionId: 's1', deviceReady: false })
    expect(view.result.current.position).toBe('unknown')
    report(steerable(true))
    expect(view.result.current.position, 'a late report repositioned an unready device').toBe('unknown')
  })

  it('says the request was abandoned, rather than ending it in silence', async () => {
    // The only terminal path that announced nothing. A click puts the control in a busy state that a
    // screen reader reads out; ending that state without a word leaves the tester with no statement
    // about the change they asked for — and dropping the late answer took away even the
    // repositioning that used to stand in for one.
    const { view, errors } = setup()
    await act(async () => { view.result.current.toggle() })
    expect(view.result.current.pending).toBe(true)

    view.rerender({ sessionId: 's1', deviceReady: false })
    expect(errors, 'the abandoned request ended silently').toHaveLength(1)
    expect(errors[0]).toMatch(/became unavailable before it answered/i)
    // No cause: `deviceReady` drops on a boot, on the agent going away and on a rebind, and only the
    // first is a restart. Naming one would be wrong two times out of three.
    expect(errors[0], 'it named a cause it cannot know').not.toMatch(/restart/i)
  })

  it('says nothing when there was no request to abandon', () => {
    // Readiness drops for reasons that have nothing to do with a click — a boot, an agent going away
    // — and announcing an abandoned request that nobody made is its own false statement.
    const { view, errors } = setup()
    view.rerender({ sessionId: 's1', deviceReady: false })
    expect(errors, 'it announced a request nobody made').toHaveLength(0)
  })

  it('takes reports again once the device is ready, and still times out if none comes', () => {
    // The half that would pass if the guard simply dropped everything: after the boot the control has
    // to listen again, and the deadline has to still be armed underneath it.
    vi.useFakeTimers()
    const { view, report } = setup()
    view.rerender({ sessionId: 's1', deviceReady: false })
    view.rerender({ sessionId: 's1', deviceReady: true })
    report(steerable(true))
    expect(view.result.current.position, 'the guard outlived the boot').toBe('offline')

    view.rerender({ sessionId: 's1', deviceReady: false })
    view.rerender({ sessionId: 's1', deviceReady: true })
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS + 1) })
    expect(view.result.current.position).toBe('unknown')
  })

  it('arms the deadline again after a reboot, so a silent boot is not left saying nothing', () => {
    // The deadline is gated on `position === 'waiting'`. Without the reset above it never re-armed
    // after the first report, so the stale answer had nothing to replace it — permanently, unlike the
    // silence before the first boot which at least resolves to `unknown`.
    vi.useFakeTimers()
    const { view, report } = setup()
    report(steerable(true))
    view.rerender({ sessionId: 's1', deviceReady: false })
    view.rerender({ sessionId: 's1', deviceReady: true })

    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS + 1) })
    expect(view.result.current.position, 'the deadline did not re-arm').toBe('unknown')
  })

  it('forgets the previous device when the session changes', () => {
    // `DeviceViewer` stays mounted across a session switch and drops frames addressed elsewhere, so
    // nothing would replace this — the last device's position would sit on screen describing another.
    const { view, report } = setup()
    report(steerable(true))
    expect(view.result.current.position).toBe('offline')

    view.rerender({ sessionId: 's2', deviceReady: true })
    expect(view.result.current.position).toBe('waiting')
  })
})
