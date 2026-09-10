/** A clock and timer boundary for a trailing-edge requester. */
export interface TimerScheduler<Timer> {
  now(): number
  schedule(callback: () => void, delayMs: number): Timer
  cancel(timer: Timer): void
}

/** A callable requester whose delayed edge can be cancelled when its owner goes away. */
export type TrailingRequester = (() => void) & { dispose(): void }

/** The production scheduler. `unref` keeps a pending request from keeping the relay process alive. */
export const systemTimerScheduler: TimerScheduler<ReturnType<typeof setTimeout>> = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return timer
  },
  cancel(timer) { clearTimeout(timer) },
}

/**
 * Calls `fire` immediately at the leading edge, then coalesces calls inside `windowMs` onto one
 * trailing edge. The scheduler is injected so the timing policy can be tested without faking the
 * relay's WebSocket or heartbeat timers.
 */
export function createTrailingRequester<Timer>(options: {
  scheduler: TimerScheduler<Timer>
  windowMs: number
  fire: () => void
}): TrailingRequester {
  const { scheduler, windowMs, fire } = options
  let lastAt: number | null = null
  let pending: Timer | null = null

  const fireNow = () => {
    lastAt = scheduler.now()
    fire()
  }

  const requester = (() => {
    if (lastAt === null) {
      fireNow()
      return
    }

    const wait = windowMs - (scheduler.now() - lastAt)
    if (wait <= 0) {
      // A timer that became due while another callback was running must not fire after this leading
      // edge as well. Node normally runs due timers first, but that ordering is not a second budget.
      if (pending !== null) {
        scheduler.cancel(pending)
        pending = null
      }
      fireNow()
      return
    }

    // Already coalesced. A second timer here would be the double send the window is for.
    if (pending !== null) return
    pending = scheduler.schedule(() => {
      pending = null
      fireNow()
    }, wait)
  }) as TrailingRequester

  requester.dispose = () => {
    if (pending !== null) {
      scheduler.cancel(pending)
      pending = null
    }
  }

  return requester
}
