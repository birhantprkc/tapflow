import type { BrowserToRelay, DeviceShutdownDone, DeviceShutdownError } from '@tapflowio/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { newRequestId } from '@/lib/requestId'

/** The two frames that can answer a `device:shutdown`. */
export type RebootMessage = DeviceShutdownDone | DeviceShutdownError

export type RebootMessageHandler = (msg: RebootMessage) => void

interface Options {
  sessionId: string
  deviceId: string
  /**
   * True while a device is on screen.
   *
   * **The one input that stands in for three lifecycle signals**, which is why the hook takes it
   * rather than each of them: `session:agent-away` removes the agent that would answer, a socket
   * reconnect re-joins and boots through `session:joined`, and `session:rebound` boots the device
   * itself — and `DeviceViewer` drops readiness on all three. `useNetworkControl` takes it for the
   * same reason.
   *
   * Losing it after the shutdown has been answered costs nothing: this hook is already done by then,
   * because `device:booting` cannot arrive until the boot it sent does.
   */
  deviceReady: boolean
  send: (msg: BrowserToRelay) => void
  /** `DeviceViewer` routes the two shutdown replies here; the hook registers itself on mount. */
  handlerRef: MutableRefObject<RebootMessageHandler | undefined>
  /**
   * The shutdown landed — boot the device.
   *
   * The boot is **not** sent from here. `DeviceViewer` owns the correlator bookkeeping every boot
   * shares (`bootIdsRef`, `latestBootIdRef`), and a second sender that kept its own would be the
   * third copy of that idiom with nothing holding the copies together.
   */
  onShutdownComplete: () => void
  /** Told when the sequence stopped and the device is still up, since nothing else renders that. */
  onError: (message: string) => void
}

/**
 * How long to wait before the control stops blocking on the shutdown.
 *
 * **It releases the control; it does not abandon the sequence.** An answer that arrives after it still
 * boots the device — see the timer body for why that distinction is the difference between a slow
 * restart and a device left powered off with nothing in the app that will bring it back.
 *
 * **Silence is a reachable answer here, not a hang to be defended against.** Both agents open
 * `handleDeviceShutdown` with `if (!state) return` — no `device:shutdown-done`, no error, nothing —
 * and `IOSAgent`'s own catch logs a failed `simctl shutdown` and sends nothing either. That is
 * deliberate on the protocol's side: `DeviceShutdownError` is declared `RelayToBrowser`, and its doc
 * says both agents "ack a shutdown they cannot perform by simply not sending `device:shutdown-done`".
 * So without this the control spins for the rest of the session on a shutdown nobody will answer.
 *
 * 20s because the agent awaits the real shutdown before answering — `simctl shutdown` on a busy Mac,
 * or `adb emu kill` on an emulator mid-write. Generous on purpose: being early means saying something
 * to a tester whose restart is merely slow, and what it says has to stay true of that case.
 */
export const REBOOT_SHUTDOWN_DEADLINE_MS = 20_000

/**
 * Reboot the device the viewer is showing (#628).
 *
 * **The dashboard sequences this rather than the agent**, because `device:boot` on a running device
 * does nothing: the non-erase path issues `simctl boot`, which swallows `Unable to boot device in
 * current state: Booted` on purpose. Only `full-erase` shuts the device down first, and a reboot is
 * not a request to erase (#439). So a reboot is a `device:shutdown` followed by a `device:boot`, both
 * of which this app already sends elsewhere and the relay already answers.
 *
 * What this hook owns is the half that did not exist: the wait between the two. The boot half needs
 * nothing new — `device:booting` unmounts the viewer and `device:ready` brings it back, which is the
 * same thing a first boot does and is why a reboot needs no progress display of its own.
 */
export function useDeviceReboot({ sessionId, deviceId, deviceReady, send, handlerRef, onShutdownComplete, onError }: Options) {
  const [pending, setPending] = useState(false)
  const requestId = useRef<string | null>(null)

  // Read through refs so the handler registered below does not have to be rebuilt — and so the
  // deadline, which fires long after the render that armed it, calls the current one.
  const onCompleteRef = useRef(onShutdownComplete)
  const onErrorRef = useRef(onError)
  useEffect(() => { onCompleteRef.current = onShutdownComplete }, [onShutdownComplete])
  useEffect(() => { onErrorRef.current = onError }, [onError])

  // A new session is a different device. Nothing in flight for the old one can be answered here.
  useEffect(() => {
    setPending(false)
    requestId.current = null
  }, [sessionId])

  /**
   * **Something else took the device, so this sequence is over whatever it was waiting for.**
   *
   * Distinct from the deadline above, which keeps its correlator on purpose: a deadline means the
   * answer is merely late, and a late answer should still finish the restart. This means the device
   * has been claimed by a boot this hook did not send — a rebind, a reconnect, an agent that went
   * away — so the answer, if it ever comes, would boot a device somebody else is already booting.
   *
   * Without it the control came back from a *successful* rebind still spinning, announcing "Restarting
   * the device." over a device that had finished, and then toasted a failure at the deadline.
   */
  useEffect(() => {
    if (deviceReady) return
    setPending(false)
    requestId.current = null
  }, [deviceReady])

  useEffect(() => {
    handlerRef.current = (msg) => {
      // **Correlated, and this is the one thing that must not be relaxed.** `useAgentSession` sends
      // three *uncorrelated* `device:shutdown`s on the way out of a view, and this file's header
      // (`lib/inboundDisposition.ts`) says any browser socket can receive any message — a reply to
      // somebody's teardown reaching here uncompared would boot a device that was just shut down on
      // purpose, from a screen the tester has left.
      //
      // One comparison covers the id-less case too, and that is worth saying because the explicit
      // `msg.requestId === undefined ||` that stood here read as load-bearing and was not: this ref
      // holds `string | null`, so an absent correlator is `undefined !== null` and already rejected.
      // Mutation testing is what said so — deleting that clause changed no test.
      if (msg.requestId !== requestId.current) return
      requestId.current = null
      setPending(false)
      if (msg.type === 'device:shutdown-error') {
        // The device is still up: the relay refused to dispatch, so nothing reached it. Said rather
        // than rendered, because the control it came from goes back to looking exactly as it did.
        onErrorRef.current(`The device was not restarted. ${msg.message}`)
        return
      }
      onCompleteRef.current()
    }
    return () => { handlerRef.current = undefined }
  }, [handlerRef])

  // Armed on the id rather than on `pending`, so a second reboot's wait cannot be cleared by the
  // first one's timer — the same shape `useNetworkControl` arrived at for its request deadline.
  const [waitingOn, setWaitingOn] = useState<string | null>(null)
  useEffect(() => { setWaitingOn(pending ? requestId.current : null) }, [pending])
  useEffect(() => {
    if (waitingOn === null) return
    const timer = setTimeout(() => {
      if (requestId.current !== waitingOn) return
      // **The id is deliberately kept.** Clearing it here dropped the answer when it did arrive late,
      // and a dropped answer is not a stalled restart — it is a device left powered off with nothing
      // in the app that will boot it again. `IOSAgent.handleDeviceShutdown` tears the streamer down
      // before it awaits `simctl shutdown`, and the relay tells the browser nothing when that socket
      // closes, so `deviceReady` stays true and the canvas holds its last frame: a device that reads
      // as running, under a message saying it probably is.
      //
      // Keeping it is safe because a second press mints a fresh one, so this correlator can never
      // answer a request the tester has replaced.
      setPending(false)
      onErrorRef.current('The device has not answered the restart yet. If its answer arrives tapflow will finish restarting it; if nothing changes, press Restart again.')
    }, REBOOT_SHUTDOWN_DEADLINE_MS)
    return () => clearTimeout(timer)
  }, [waitingOn])

  const reboot = useCallback(() => {
    if (pending) return
    const id = newRequestId()
    requestId.current = id
    setPending(true)
    send({ type: 'device:shutdown', sessionId, requestId: id, payload: { deviceId } })
  }, [pending, send, sessionId, deviceId])

  return { pending, reboot }
}
