import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { BrowserInbound, SessionInfo } from '@/lib/types'

// Regression: a refused shutdown left the row inert for the rest of the page's life.
//
// `handleShutdown` sends `session:start` on this socket before `device:shutdown`, because the relay
// routes agent replies to whichever socket holds the session. If that join is refused — the device is
// open in another browser session, the commonest reason to be shutting it down from here — the relay
// answers `error` on this socket and returns. `device:shutdown-done` is the only message that clears
// `shutting`, and it never comes.
//
// The badge then reads "Shutting down..." forever, and `isShutting` hides both Connect and Shutdown, so
// the tester cannot retry or leave. It is the same defect `DeviceViewer` had for `Session busy`, in a
// second component — and the disposition table's first version *hid* it by claiming `error` was handled
// here, which the check certified because three unrelated `'error'` strings live in this file.
const send = vi.fn()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

const { SessionList } = await import('@/components/SessionList')

const SESSIONS: SessionInfo[] = [{
  agentName: 'mac-1',
  capabilities: [],
  devices: [{
    id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted',
    sessionId: 's1', busy: false,
  }],
}]

const TWO_DEVICES: SessionInfo[] = [{
  agentName: 'mac-1',
  capabilities: [],
  devices: [
    { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', sessionId: 's1', busy: false },
    { id: 'dev-2', name: 'iPhone 14', platform: 'ios', status: 'booted', sessionId: 's2', busy: false },
  ],
}]

describe('SessionList when a shutdown is refused', () => {
  // `toast` is module-mocked, so its call history outlives a test. Two of the cases below count toasts,
  // and with only `send` cleared the second one to run inherits the first's calls.
  beforeEach(() => { vi.clearAllMocks(); deliver = null })

  it('clears the shutting badge and says why, instead of leaving the row inert', async () => {
    const { toast } = await import('sonner')
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: SESSIONS }) })

    act(() => { screen.getByRole('button', { name: /shutdown/i }).click() })
    expect(screen.getByText(/shutting down/i)).toBeInTheDocument()

    act(() => {
      deliver!({ type: 'error', sessionId: 's1', message: 'Session busy', reason: 'session-busy' })
    })

    // The badge is gone, so the row's buttons are back and the tester can act.
    expect(screen.queryByText(/shutting down/i)).not.toBeInTheDocument()
    expect(vi.mocked(toast.error)).toHaveBeenCalledOnce()
    // And it says which of the three reasons it was, rather than a generic failure.
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/another browser session/i)
  })

  // The toast above says the device was not shut down. That has to be *true*.
  //
  // The relay forwards a session-scoped browser command on the strength of the session existing — it does
  // not check that the sender owns it. So sending `device:shutdown` in the same breath as `session:start`
  // meant a refused join was followed by a shutdown that went through anyway: another tester's device went
  // down while this list reported that nothing had happened.
  it('does not send the shutdown when the join was refused', () => {
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: SESSIONS }) })

    act(() => { screen.getByRole('button', { name: /shutdown/i }).click() })
    expect(send.mock.calls.map(([m]) => m.type)).toEqual(['agents:list', 'session:start'])

    act(() => { deliver!({ type: 'error', sessionId: 's1', message: 'Session busy', reason: 'session-busy' }) })

    expect(send.mock.calls.some(([m]) => m.type === 'device:shutdown')).toBe(false)
  })

  it('sends the shutdown once the join is accepted', () => {
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: SESSIONS }) })
    act(() => { screen.getByRole('button', { name: /shutdown/i }).click() })

    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })

    expect(send.mock.calls.some(([m]) => m.type === 'device:shutdown' && m.sessionId === 's1')).toBe(true)
  })

  it('does not fire on a join for a different session', () => {
    // The handler used to accept *any* `session:joined` as the answer to its pending request. Only this
    // list sends `session:start` from here, so a mismatch is unreachable today — but the two previous
    // versions of this handler each rested on an "unreachable today" that turned out to be wrong, so the
    // request is matched rather than counted.
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: TWO_DEVICES }) })
    act(() => { screen.getAllByRole('button', { name: /shutdown/i })[0].click() })   // pending s1

    act(() => { deliver!({ type: 'session:joined', sessionId: 's2', capabilities: [] }) })

    expect(send.mock.calls.some(([m]) => m.type === 'device:shutdown')).toBe(false)

    // And the request survives, so the real answer still works.
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
    expect(send.mock.calls.some(([m]) => m.type === 'device:shutdown' && m.sessionId === 's1')).toBe(true)
  })

  // The other door into the same inert row. Everything above is about a refused **join**; this is a join
  // that succeeded and a **shutdown** the relay could not deliver — no such session, or its agent gone.
  // Until #542 that arrived as nothing at all, so the row sat on "Shutting down…" for the page's life with
  // both buttons hidden, exactly as a refused join used to.
  it('clears the badge when the relay could not deliver the shutdown', async () => {
    const { toast } = await import('sonner')
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: SESSIONS }) })
    act(() => { screen.getByRole('button', { name: /shutdown/i }).click() })
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
    expect(screen.getByText(/shutting down/i)).toBeInTheDocument()

    act(() => {
      deliver!({ type: 'device:shutdown-error', sessionId: 's1', message: 'agent offline' })
    })

    expect(screen.queryByText(/shutting down/i)).not.toBeInTheDocument()
    expect(vi.mocked(toast.error)).toHaveBeenCalledOnce()
    expect(vi.mocked(toast.error).mock.calls[0][1]).toMatchObject({ description: 'agent offline' })
  })

  it('ignores a shutdown-error for a session it never shut down', async () => {
    const { toast } = await import('sonner')
    // The reply is addressed to a session and carries no `payload`, while `shutting` is keyed by device —
    // so the deviceId comes from what this list actually sent. Without that lookup the handler would have
    // to clear something, and the honest options are "nothing" or "the wrong row". This pins the first:
    // `useAgentSession` shares no socket with this list, but the relay's own idle timer and any future
    // sender make an unrelated error reachable, and clearing a badge for a shutdown still in progress is
    // the inert row's mirror image — a row that says it is done when it is not.
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: TWO_DEVICES }) })
    act(() => { screen.getAllByRole('button', { name: /shutdown/i })[0].click() })
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })

    act(() => {
      deliver!({ type: 'device:shutdown-error', sessionId: 's2', message: 'Session not found' })
    })

    expect(screen.getByText(/shutting down/i)).toBeInTheDocument()
    // And it stays quiet. Correlating before clearing the badge but not before toasting would leave this
    // tester reading someone else's failure — a second reply routed to a socket that did not ask, which
    // is the class the correlation work exists to close.
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('refuses a second shutdown while one is still unanswered', () => {
    // Not the original reason any more. That one was "`error` carries no sessionId, so two in flight would
    // leave the handler unable to say which row a refusal belongs to" — and it **expired in L5d**, which made
    // the refusal name its session. The guard is what keeps `pendingRef` a single slot, which is what the
    // handler's unconditional clear depends on, and #527 has this list joining before it shuts down as a
    // stand-in for a missing server check, so two in flight would interleave those joins. See
    // `SessionList.tsx`'s comment on `handleShutdown`, which carries the same correction.
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: TWO_DEVICES }) })

    const buttons = screen.getAllByRole('button', { name: /shutdown/i })
    act(() => { buttons[0].click() })
    act(() => { buttons[1].click() })

    expect(send.mock.calls.filter(([m]) => m.type === 'session:start')).toHaveLength(1)
  })
})
