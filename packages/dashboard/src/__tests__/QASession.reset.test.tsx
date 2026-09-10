import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BreadcrumbProvider, useBreadcrumb } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, SessionInfo } from '@/lib/types'

// The two halves of the #439 fix only meet here: the hook decides what the reset is, the viewer
// decides how often it is sent, and QASession is the wiring between them. Both halves have their
// own unit tests; this file exists because swapping the prop back to the live toggle, or adding a
// wrapper that stops DeviceViewer from remounting, breaks the feature without failing either.
const { viewerMounts, send } = vi.hoisted(() => ({
  viewerMounts: [] as Array<{ deviceId: string; resetMode?: string }>,
  send: vi.fn(),
}))

let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
// Mutable so a test can flip the platform; reset in beforeEach.
const { BUILD } = vi.hoisted(() => ({
  BUILD: {
    id: 7, app_id: 3, name: 'Demo', platform: 'ios', status_label: null,
    version_name: '1.0', build_number: '1',
  },
}))
const BUILD_LABEL = '1.0 · build 1'
vi.mock('@/hooks/useBuildLoader', () => ({ useBuildLoader: () => ({ build: BUILD }) }))
vi.mock('@/components/SessionPanel', () => ({ SessionPanel: () => <div /> }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

vi.mock('@/components/DeviceViewer', async () => {
  const { useEffect } = await import('react')
  return {
    DeviceViewer: ({ deviceId, resetMode }: { deviceId: string; resetMode?: string }) => {
      // Mount only — resetSentRef is per-mount, so "did it remount" is the property under test.
      // With deviceId/resetMode in the deps this would fire on a prop change too and stop
      // distinguishing a remount from a re-render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => { viewerMounts.push({ deviceId, resetMode }) }, [])
      return <div data-testid="device-viewer" />
    },
  }
})

const { QASession } = await import('../pages/QASession')

const device = (id: string, name: string, platform = 'ios') => ({
  id, name, platform, status: 'shutdown', osVersion: 'iOS 18.3', sessionId: 'sess-1', busy: false,
})
// `capabilities` is what gates the toggle now, not `platform` (#447). Both shipped agents advertise
// `full-reset` as of the Android wipe; `ANDROID_AGENTS` keeps a list without it on purpose — it is
// no longer a portrait of AndroidAgent but of **any** agent that does not implement the feature,
// which is what the gate is actually written against and what the tests below need.
const AGENTS: SessionInfo[] = [{
  agentName: 'studio-mac',
  platform: 'ios',
  capabilities: ['clipboard', 'full-reset'],
  devices: [device('dev-a', 'iPhone 15'), device('dev-b', 'iPhone SE')],
}]
const ANDROID_AGENTS: SessionInfo[] = [{
  agentName: 'studio-mac',
  platform: 'android',
  capabilities: ['clipboard'],
  devices: [device('dev-a', 'Pixel 7', 'android')],
}]
const MIXED_CAPABILITY_AGENTS: SessionInfo[] = [
  ...AGENTS,
  {
    agentName: 'legacy-mac',
    platform: 'ios',
    capabilities: ['clipboard'],
    devices: [device('dev-c', 'iPhone 14')],
  },
]

/** The breadcrumb is rendered by the layout, outside QASession — and once a session is open it is
 *  the only way back to the Mac list, which is the path this issue is about. */
function Harness() {
  const { node } = useBreadcrumb()
  return <>{node}<QASession /></>
}

async function openDeviceList(user: ReturnType<typeof userEvent.setup>, agents = AGENTS) {
  render(
    <MemoryRouter initialEntries={['/qa?id=7']}>
      <BreadcrumbProvider><Harness /></BreadcrumbProvider>
    </MemoryRouter>,
  )
  await vi.waitFor(() => expect(deliver).not.toBeNull())
  await act(async () => { deliver!({ type: 'agents:listed', sessions: agents }) })
  await user.click(await screen.findByText('studio-mac'))
}

/** Leave the open session and come back to the same device list. */
async function backToDeviceList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: BUILD_LABEL }))
  await user.click(await screen.findByText('studio-mac'))
}

describe('QASession — Full reset applies to exactly one pick (#439)', () => {
  beforeEach(() => {
    viewerMounts.length = 0
    send.mockClear()
    deliver = null
    BUILD.platform = 'ios'
  })

  it('erases the device it was armed for, and not the next one', async () => {
    const user = userEvent.setup()
    await openDeviceList(user)

    // Arm, then pick device A.
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByText('iPhone 15'))
    expect(viewerMounts).toEqual([{ deviceId: 'dev-a', resetMode: 'full-erase' }])

    // Back to the list — a conditional re-render, not a route change. This is the path that used
    // to carry the armed toggle into the next pick.
    await backToDeviceList(user)
    await user.click(screen.getByText('iPhone SE'))

    expect(viewerMounts).toEqual([
      { deviceId: 'dev-a', resetMode: 'full-erase' },
      { deviceId: 'dev-b', resetMode: 'app-only' },
    ])
  })

  it('turns the toggle off in the same click, so the UI shows what will happen', async () => {
    const user = userEvent.setup()
    await openDeviceList(user)

    await user.click(screen.getByRole('switch'))
    expect(screen.getByRole('switch')).toBeChecked()

    await user.click(screen.getByText('iPhone 15'))
    await backToDeviceList(user)

    expect(screen.getByRole('switch')).not.toBeChecked()
  })

  it('arms again when the tester asks again', async () => {
    const user = userEvent.setup()
    await openDeviceList(user)

    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByText('iPhone 15'))
    await backToDeviceList(user)
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByText('iPhone SE'))

    expect(viewerMounts.at(-1)).toEqual({ deviceId: 'dev-b', resetMode: 'full-erase' })
  })

  // The track colour is `data-[state=checked|unchecked]:bg-*` and nothing else. Putting Radix's
  // TooltipTrigger on the Switch with `asChild` overwrites that attribute with its own open/closed
  // state, and the switch renders as an invisible track with a floating thumb.
  it('leaves the switch its own data-state, which is what colours it', async () => {
    const user = userEvent.setup()
    await openDeviceList(user)

    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'unchecked')
    await user.click(screen.getByRole('switch'))
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'checked')
  })

  // #447: AndroidAgent never reads resetMode. A switch that erases nothing is worse than no
  // switch, and worse still now that it disarms itself as if it had run.
  it('does not offer Full reset on Android', async () => {
    BUILD.platform = 'android'
    const user = userEvent.setup()
    await openDeviceList(user, ANDROID_AGENTS)

    expect(screen.queryByRole('switch')).not.toBeInTheDocument()

    // This only pins Android's default mount; the armed capability guard is covered by the
    // mixed-agent case below.
    await user.click(screen.getByText('Pixel 7'))
    expect(viewerMounts).toEqual([{ deviceId: 'dev-a', resetMode: 'app-only' }])
  })

  it('does not carry an armed full reset to an agent that lacks the capability', async () => {
    const user = userEvent.setup()
    await openDeviceList(user, MIXED_CAPABILITY_AGENTS)

    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: '← All Macs' }))
    await user.click(screen.getByText('legacy-mac'))
    await user.click(screen.getByText('iPhone 14'))

    expect(viewerMounts).toEqual([{ deviceId: 'dev-c', resetMode: 'app-only' }])
  })

  it('mounts a fresh viewer per pick — the per-mount reset guard depends on it', async () => {
    const user = userEvent.setup()
    await openDeviceList(user)

    await user.click(screen.getByText('iPhone 15'))
    await backToDeviceList(user)
    await user.click(screen.getByText('iPhone SE'))

    // Two mounts, not one re-render. A wrapper or a shared key here would collapse these into one
    // and DeviceViewer would keep a resetSentRef that is already spent.
    expect(viewerMounts).toHaveLength(2)
    expect(viewerMounts.map((m) => m.deviceId)).toEqual(['dev-a', 'dev-b'])
  })
})
