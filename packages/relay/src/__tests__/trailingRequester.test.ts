import { describe, expect, it, vi } from 'vitest'
import { createTrailingRequester, type TimerScheduler } from '../lib/trailingRequester.js'

type FakeTimer = {
  at: number
  callback: () => void
}

type FakeScheduler = TimerScheduler<FakeTimer> & {
  advanceBy(ms: number): void
  elapseWithoutRunning(ms: number): void
  activeTimerCount(): number
  runDue(): void
}

function fakeScheduler(): FakeScheduler {
  let now = 0
  const timers = new Set<FakeTimer>()

  const runDue = () => {
    while (true) {
      const due = [...timers]
        .filter((timer) => timer.at <= now)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) return
      timers.delete(due)
      due.callback()
    }
  }

  return {
    now: () => now,
    schedule(callback, delay) {
      const timer = { at: now + delay, callback }
      timers.add(timer)
      return timer
    },
    cancel(timer) { timers.delete(timer) },
    advanceBy(ms) {
      now += ms
      runDue()
    },
    elapseWithoutRunning(ms) { now += ms },
    activeTimerCount: () => timers.size,
    runDue,
  }
}

describe('createTrailingRequester', () => {
  it('coalesces a burst into one trailing request at the window boundary', () => {
    const scheduler = fakeScheduler()
    const fire = vi.fn()
    const requester = createTrailingRequester({ scheduler, windowMs: 500, fire })

    requester()
    scheduler.advanceBy(100)
    requester()
    requester()
    requester()

    expect(fire).toHaveBeenCalledTimes(1)
    expect(scheduler.activeTimerCount()).toBe(1)

    scheduler.advanceBy(399)
    expect(fire).toHaveBeenCalledTimes(1)

    scheduler.advanceBy(1)
    expect(fire).toHaveBeenCalledTimes(2)
    expect(scheduler.activeTimerCount()).toBe(0)
  })

  it('fires immediately again at the exact window boundary', () => {
    const scheduler = fakeScheduler()
    const fire = vi.fn()
    const requester = createTrailingRequester({ scheduler, windowMs: 500, fire })

    requester()
    scheduler.advanceBy(500)
    requester()

    expect(fire).toHaveBeenCalledTimes(2)
    expect(scheduler.activeTimerCount()).toBe(0)
  })

  it('cancels its trailing request when disposed', () => {
    const scheduler = fakeScheduler()
    const fire = vi.fn()
    const requester = createTrailingRequester({ scheduler, windowMs: 500, fire })

    requester()
    scheduler.advanceBy(100)
    requester()
    expect(scheduler.activeTimerCount()).toBe(1)

    requester.dispose()
    expect(scheduler.activeTimerCount()).toBe(0)
    scheduler.advanceBy(400)

    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('replaces an overdue trailing request instead of firing both edges', () => {
    const scheduler = fakeScheduler()
    const fire = vi.fn()
    const requester = createTrailingRequester({ scheduler, windowMs: 500, fire })

    requester()
    scheduler.advanceBy(100)
    requester()
    scheduler.elapseWithoutRunning(400)

    requester()
    expect(fire).toHaveBeenCalledTimes(2)
    expect(scheduler.activeTimerCount()).toBe(0)

    scheduler.runDue()
    expect(fire).toHaveBeenCalledTimes(2)
  })
})
