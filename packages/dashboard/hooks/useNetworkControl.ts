import type { BrowserToRelay, NetworkError, NetworkState, NetworkUnavailableReason } from '@tapflowio/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { newRequestId } from '@/lib/requestId'

/** The two frames the agent answers a network request with, plus the report it sends unasked. */
export type NetworkMessage = NetworkState | NetworkError

export type NetworkMessageHandler = (msg: NetworkMessage) => void

/**
 * Where the device is, which is **four things and not two**.
 *
 * `unknown` means no report has arrived and the wait is over — not "the report said something
 * unhelpful". `waiting` is the wait itself, kept apart because collapsing the two would say "could
 * not read" about a device that is merely slow, a claim made before anything was asked.
 *
 * Spelling any of this as a boolean is the mistake the agent made on the other side of this wire: a
 * `lastNetworkOffline` initialised to `false` reported "on the network" for a device that had never
 * been observed, which is the one direction that hides the problem this feature exists to show.
 *
 * **`available: false` is not one of these.** An earlier draft folded it into `unknown`, reading it
 * as "could not read" — but the protocol says the opposite: `NetworkNotSteerable` is *"whatever the
 * device's network is doing, tapflow can no longer change it"*, and it carries `offline` precisely so
 * the viewer can still draw the position. Folding it here threw that away and made the control a
 * one-way ratchet: a device taken offline whose write could not be confirmed rendered as `unknown`,
 * and from `unknown` every click asked for offline again, so nothing could bring it back.
 */
export type NetworkPosition = 'waiting' | 'unknown' | 'online' | 'offline'

interface Options {
  sessionId: string
  send: (msg: BrowserToRelay) => void
  /** Does the connected agent implement network control (from `session:joined`)? */
  supported: boolean
  /** True once this session has a device on screen. Before that there is no state to wait for. */
  deviceReady: boolean
  /** `DeviceViewer` routes `network:*` here; the hook registers itself on mount. */
  handlerRef: MutableRefObject<NetworkMessageHandler | undefined>
  /** Told when something needs saying out loud rather than only rendering: a request that could not
   *  be dispatched, or enforcement that stopped underneath a device that was offline. Nothing renders
   *  a `network:error` otherwise, and a click that changes neither the toggle nor anything else is
   *  indistinguishable from a dead button. */
  onError?: (message: string) => void
}

/**
 * How long to wait for a report before calling the state unreadable.
 *
 * Derived rather than picked. The relay asks the agent on every re-join, but through a *coalescing*
 * requester whose window is `NETWORK_STATE_REQUEST_THROTTLE_MS` (500ms in `RelayServer.ts`) — so a
 * report can legitimately be one full window late before the agent has even been asked. The agent
 * then makes one adb round trip: milliseconds on a healthy device, and seconds on a Mac that is busy
 * running the emulator it is asking about.
 *
 * 3s is that window plus room for the slow case. Being generous costs nothing — a report that arrives
 * after the deadline is still applied, and `unknown` is a position the control works from rather than
 * a dead end.
 */
export const NETWORK_REPORT_DEADLINE_MS = 3_000

/**
 * How long to wait for the answer to a request before giving the control back.
 *
 * Longer than the report deadline because a `network:set` is a *write* — the agent writes airplane
 * mode and then reads it back to confirm, so two adb round trips rather than one — and because
 * giving up early on a request that is merely slow would report a failure that did not happen.
 */
export const NETWORK_REQUEST_DEADLINE_MS = 8_000

/**
 * The viewer's half of the network control (#607).
 *
 * **Never renders a position it was not told.** The toggle moves when a `network:state` arrives and
 * at no other time — not optimistically on click, and not on a `network:error`, which says the
 * request never reached a device and therefore says nothing about where that device is.
 */
export function useNetworkControl({ sessionId, send, supported, deviceReady, handlerRef, onError }: Options) {
  const [position, setPosition] = useState<NetworkPosition>('waiting')
  // Whether tapflow can still change it — a separate axis from where it is, because the protocol
  // makes them separate. Only the button's sentence depends on this; the position it draws does not.
  const [steerable, setSteerable] = useState(true)
  // **The whole reason now, where this used to keep only `awaiting-app`.** That narrowing was not
  // caution about consumers, it was caution about the *set*: every Android read failure arrived as
  // `unsupported-device` (#618), so naming one told a tester "this will never work" about a device
  // that was rebooting. The set has been split — a failure that could be transient is
  // `state-unconfirmed`, and `unsupported-device` now means the device was read and had not moved —
  // so each member says something a consumer can act on differently, which is what the type is for.
  const [reason, setReason] = useState<NetworkUnavailableReason | undefined>(undefined)
  // What was last said, so an unsolicited report does not announce the same loss twice — a re-join
  // asks for the state again, and the answer still carries the reason.
  const lastReason = useRef<NetworkUnavailableReason | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const requestId = useRef<string | null>(null)
  /** Ids of requests dropped by a readiness loss, whose answers must stay rejected once it returns. */
  const abandoned = useRef<Set<string>>(new Set())
  // Read through a ref so a caller passing an inline closure does not re-register the handler on
  // every render — the same shape `useClipboardBridge` uses for its own `onError`.
  const onErrorRef = useRef(onError)
  useEffect(() => { onErrorRef.current = onError }, [onError])

  /** Read by the handler, which is registered once — the flag itself would be captured stale. */
  const readyRef = useRef(deviceReady)
  useEffect(() => { readyRef.current = deviceReady }, [deviceReady])

  /**
   * Has this session ever had a device on screen? **Two situations were one `waiting` and they are
   * not the same claim.**
   *
   * Before the first device there is nothing to report and nobody has asked — calling that silence
   * unreadable would be a verdict on a question nobody put, which is why the deadline does not arm
   * there. After a device has been and gone, `waiting` draws a pulse and says "Checking the network
   * state." while nothing is checking and nothing will end the claim: the deadline is gated on
   * readiness, so a boot says it for 30–60s and an agent that never comes back says it forever.
   */
  const everReady = useRef(deviceReady)

  // A new session knows nothing about its device, and the previous session's answer is about somebody
  // else's. `DeviceViewer` drops frames addressed elsewhere, but it stays mounted across the switch,
  // so without this the old position would sit on screen until a new report replaced it.
  useEffect(() => {
    setPosition('waiting')
    setSteerable(true)
    setReason(undefined)
    lastReason.current = undefined
    setPending(false)
    requestId.current = null
    // **The initial value, which is `deviceReady` — not `false`.** This effect exists to put the hook
    // back where it starts for a new session, and where it starts is the ref's own initialiser.
    //
    // Hardcoding `false` was wrong for the one switch that does not pass through an unready device:
    // session A ready → session B ready leaves `deviceReady` true throughout, so the readiness effect
    // below — keyed on `deviceReady` — never runs and never raises the flag again. B then loses its
    // device and gets `waiting`, whose deadline is gated on readiness and so does not arm: "Checking
    // the network state." with nothing checking and nothing to end it.
    //
    // Read through `readyRef` so this stays keyed on `sessionId` alone. Its own effect is declared
    // above and runs first in the same flush, so it already holds this render's value.
    everReady.current = readyRef.current
    // A new session cannot receive the previous one's answers, so the set does not carry over. It
    // grows by at most one per readiness drop that catches a request in flight; this bounds it.
    abandoned.current.clear()
  }, [sessionId])

  /**
   * **A device that is not ready knows nothing about its own network, so neither does this.**
   *
   * The reset above keys on `sessionId`, which does not change across a reboot — but `deviceReady`
   * does: `DeviceViewer` drops it on `device:booting` and on agent-away, and raises it again on
   * `device:ready`. The position used to survive all of that, and the report deadline never re-armed
   * because it is gated on `position === 'waiting'`.
   *
   * So an Android emulator restarting showed the position from before it for the 30–60s the boot
   * takes — and worse than merely stale, because the agent's boot path clears airplane mode and
   * reports online. An amber "offline" sat over a device being reset to the opposite, and nothing
   * ever corrected it: the same silence that yields `unknown` before the first boot left the stale
   * answer in place after the second, permanently.
   *
   * Clearing on the way *down* rather than on the way up: the moment the device stops being ready is
   * the moment this stops knowing, and waiting until it returns would leave the false answer on
   * screen for the whole boot.
   */
  useEffect(() => {
    if (deviceReady) {
      everReady.current = true
      // Readiness returning is what makes a read genuinely expected — the relay asks on join and the
      // agent reports on ready — so this is where `waiting` belongs, and where the deadline arms.
      setPosition('waiting')
      return
    }
    // `unknown` renders as "No network state has been reported", which is true and promises no
    // ending. Only for a device that has been here: before the first one, `waiting` is still right.
    setPosition(everReady.current ? 'unknown' : 'waiting')
    // **`steerable` is a claim about the device as much as the position is**, and it was the one this
    // reset kept. A last report of `available: false` left the control disabled with `reason` cleared
    // out from under it — the reason exists to explain that disabling, so what remained was a dead
    // button with nothing to say. And `session:rebound` can put a different device on the other side
    // of this, which the retained answer would be describing.
    //
    // Back to `true`, matching the `sessionId` reset and the initial state: `waiting` with the control
    // live is where every session already begins, before any device has reported.
    setSteerable(true)
    setReason(undefined)
    lastReason.current = undefined
    // An in-flight request cannot be answered by a device that is rebooting, and leaving `pending`
    // set would disable the control for as long as the boot takes.
    //
    // **And it is said out loud, because this ending happens *to* the tester.** A dispatch failure
    // announces itself through `network:error` and an unanswered request through the deadline below;
    // this one cleared the wait in silence, and once the late answer started being dropped it took
    // away even the repositioning that used to stand in for an outcome. The busy state stopped and a
    // screen-reader user heard nothing about the change they asked for.
    //
    // The `sessionId` reset above stays silent on purpose, and is the one other path that does: that
    // is the tester navigating away themselves, to a screen where the device this concerns is no
    // longer shown. A toast about it would have to name a device they have left.
    //
    // **No cause is named**, because three different things drop readiness — `device:booting`,
    // `session:agent-away` and `session:rebound` — and only the first is a restart. Saying so would
    // put a wrong reason in front of the tester two times out of three.
    if (requestId.current) {
      onErrorRef.current?.('The device became unavailable before it answered. Its network state is unchanged as far as tapflow can tell.')
      // Remembered, not merely dropped: the reply can still arrive, and by then readiness may have
      // returned and the handler be listening again. See the abandoned-id guard in `handle`.
      abandoned.current.add(requestId.current)
    }
    setPending(false)
    requestId.current = null
  }, [deviceReady])

  useEffect(() => {
    if (!supported) return
    handlerRef.current = (msg) => {
      if (msg.type === 'network:error') {
        // Only clears the wait. `network:error` means the request could not be dispatched — no booted
        // device, or a payload the agent could not read — so the device is wherever it already was.
        if (msg.requestId === requestId.current) {
          requestId.current = null
          setPending(false)
          // Announced rather than swallowed. `toast.error` renders with `role="alert"`, so this is
          // also the only thing that tells a screen-reader user the click went nowhere.
          onErrorRef.current?.(msg.message)
        }
        return
      }
      // Branched rather than assumed, and the two are not the same. Treating "not an error" as a state
      // would make a third `network:*` message — the protocol has two today — silently reposition the
      // control, and `scripts/__tests__/inboundDisposition.test.mjs` will not accept a file that claims
      // to handle a message without comparing against it.
      if (msg.type !== 'network:state') return
      // **A device that is not ready has nothing true to say about its network, including in an
      // answer that was already on its way.**
      //
      // The reset above clears the position and the in-flight request when readiness drops, but the
      // answer to that request can still arrive — and a `network:state` was applied whatever it was
      // correlated to. It would put the pre-reboot position back, and because the report deadline is
      // gated on `position === 'waiting'` it would also stop the wait from ever resolving to
      // `unknown`: exactly the stale answer this hook was changed to end, restored by the change
      // itself. The relay's own `network:request-state` on `session:joined` reaches here the same way,
      // racing the boot it arrives with.
      if (!readyRef.current) return
      // **A request this hook gave up on stays given up on, after readiness returns.**
      //
      // The guard above only holds while the device is away. A reply to a request abandoned by that
      // drop can land *after* `device:ready` — the socket delivers in order, but the answer was
      // produced before the reboot and the handler is listening again by the time it arrives. It
      // would put the pre-reboot position back, and because the report deadline is gated on
      // `position === 'waiting'` it would also stop the wait resolving to `unknown`: the stale
      // answer this hook exists to end, arriving one transition later.
      //
      // **Only ids this hook abandoned**, not every id that is not the outstanding one. A session is
      // shared, and an answer correlated to *another viewer's* request is still a true statement
      // about the device — the branch below applies it and leaves `pending` alone, which is a
      // decision with its own test. Rejecting on `!== requestId.current` would take that out.
      if (msg.requestId !== undefined && abandoned.current.has(msg.requestId)) return
      // **The position comes from `offline` whatever `available` says.** A device tapflow can no
      // longer steer still has a network state, and the protocol carries the field on both members
      // for exactly that. What `available` changes is what the button can promise, not where it points.
      //
      // **The reason is passed through whole**, where this used to keep `awaiting-app` and drop the
      // rest. What made dropping them right was a set that conflated — see `reason` above — and what
      // makes passing them on right is that it no longer does. The rendering decisions stay in the
      // component, which is where the sentences are.
      const next = msg.payload.available ? undefined : msg.payload.reason
      setPosition(msg.payload.offline ? 'offline' : 'online')
      setSteerable(msg.payload.available)
      setReason(next)
      // **The one reason that has to interrupt rather than re-colour.** It says a device that was
      // offline stopped being enforced, so requests a tester believed were blocked had been
      // succeeding — a finished test, invalidated. Everything else here changes what the control
      // looks like; this changes what the tester has to do about work already done.
      //
      // Only on the way in. A re-join asks for the state again and the answer still carries it, and
      // announcing the same loss on every re-join would train people to dismiss it.
      if (next === 'enforcement-lost' && lastReason.current !== 'enforcement-lost') {
        onErrorRef.current?.('The device went back on the network before you took it off. Anything checked while it was offline needs checking again.')
      }
      lastReason.current = next
      if (msg.requestId !== undefined && msg.requestId === requestId.current) {
        requestId.current = null
        setPending(false)
      }
    }
    return () => { handlerRef.current = undefined }
  }, [handlerRef, supported])

  // Nothing else produces a `network:state`, so a request the agent never answers would leave this
  // waiting on a report that is not coming. Three silences reach here identically — an agent that
  // does not implement the message, a relay that believes the session is ready while the agent holds
  // no device, and a socket that was not open when the request fired — and `unknown` is the honest
  // rendering of all three. What it must not do is say that *before* the wait is over.
  //
  // Armed when the device becomes ready, which is also when the relay does its asking.
  useEffect(() => {
    if (!supported || !deviceReady || position !== 'waiting') return
    // Functional, and the guard is **not** redundant with the one above. Disarming depends on this
    // effect's cleanup, which runs in React's passive-effect flush — not in the WS handler that just
    // called `setPosition`. A report landing in the milliseconds before that flush would otherwise be
    // applied and then overwritten, which is exactly where the slow-but-legitimate report lands.
    const timer = setTimeout(() => setPosition((p) => (p === 'waiting' ? 'unknown' : p)), NETWORK_REPORT_DEADLINE_MS)
    return () => clearTimeout(timer)
  }, [supported, deviceReady, position])

  /**
   * Ask for the opposite of what is on screen — and from `waiting` or `unknown`, ask to go offline.
   *
   * That default is what keeps the control usable rather than merely visible. A device whose state
   * cannot be read still has one, and the only way to find out is to change it and read the answer.
   * Offline is also the direction a tester came here for.
   */
  const toggle = useCallback(() => {
    if (!supported || pending) return
    const id = newRequestId()
    requestId.current = id
    setPending(true)
    send({ type: 'network:set', sessionId, requestId: id, payload: { offline: position !== 'offline' } })
  }, [position, pending, send, sessionId, supported])

  // **A request can go unanswered, and without this the control never recovers.** `send` drops the
  // frame outright when the socket is not open — no queue, no throw — and an agent that receives it
  // and then dies is answered by nobody, since the relay only produces `network:error` for what *it*
  // could not dispatch. `pending` would then stay true for the life of the session: a spinner that
  // never stops, a button whose every click is swallowed by the guard above, and a live region stuck
  // on "Changing the network state." `useClipboardBridge` arms the same kind of budget per request.
  //
  // Keyed on `requestId.current` through a state mirror so the timer belongs to *this* request; a
  // reply that arrives first clears the id and takes the timer with it.
  const [inFlight, setInFlight] = useState<string | null>(null)
  useEffect(() => { setInFlight(pending ? requestId.current : null) }, [pending])
  useEffect(() => {
    if (inFlight === null) return
    const timer = setTimeout(() => {
      if (requestId.current !== inFlight) return
      requestId.current = null
      setPending(false)
      onErrorRef.current?.('The device did not answer. Its network state is unchanged as far as tapflow can tell.')
    }, NETWORK_REQUEST_DEADLINE_MS)
    return () => clearTimeout(timer)
  }, [inFlight])

  return { position, steerable, reason, pending, toggle }
}
