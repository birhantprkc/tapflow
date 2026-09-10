// The toolbar's four groups, in the order a tester works through them (#634).
//
// **This holds the toolbar's own order, and not the viewers' — which is worth knowing before trusting
// it.** The slots below are stand-in buttons, so what fails here is the toolbar putting its groups in
// the wrong sequence or losing a boundary. Whether `AndroidViewer` and `IOSViewer` hand it the right
// buttons is a different fact, pinned in `scripts/__tests__/androidButtonsClassified.test.mjs`; an
// earlier version of this comment claimed this file caught that too, and a reviewer showed it does
// not — moving every Android button into one group leaves this green.
//
// Asserted as **relative order in the accessibility tree**, not as a count or a snapshot: a count
// passes on buttons in the wrong groups, and a snapshot fails on every unrelated style change and
// gets updated without being read.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SimulatorToolbar } from '@/components/device/shared/SimulatorToolbar'

/** Stand-ins for what the viewers pass, labelled so the assertions read as the rule does. */
const navButtons = <button aria-label="Home" />
const deviceButtons = <button aria-label="Software keyboard" />
/** Passed on purpose: it is conditional in the real viewers, so a fixture without it lets the launch
 *  button drift outside every group unnoticed — which is the one flat-run state this all exists to end. */
const launch = <button aria-label="Launch app" />

function toolbar({ network = true, onReboot = () => {} }: { network?: boolean; onReboot?: () => void } = {}) {
  return render(
    <SimulatorToolbar
      reboot={{ pending: false, onReboot }}
      joined
      onScreenshot={() => {}}
      onRecordToggle={() => {}}
      recordState="idle"
      onRotate={() => {}}
      onDeepLink={() => {}}
      launchSlot={launch}
      navigationSlot={navButtons}
      deviceSlot={deviceButtons}
      network={network ? { position: 'online', steerable: true, pending: false, onToggle: () => {} } : undefined}
    />,
  )
}

/** Where each button sits in the rendered order, by accessible name. */
function positions() {
  const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '')
  return (label: RegExp) => names.findIndex((n) => label.test(n))
}

describe('the device toolbar groups by what the tester is doing to the device', () => {
  it('runs Navigation → Device → Capture → Environment', () => {
    toolbar()
    const at = positions()
    const navigation = at(/^Home$/)
    const device = at(/Software keyboard/)
    const rotate = at(/Rotate/)
    const capture = at(/screenshot/i)
    const environment = at(/device (offline|online|network)/i)

    for (const [name, i] of Object.entries({ navigation, device, rotate, capture, environment })) {
      expect(i, `${name} is not rendered at all`).toBeGreaterThan(-1)
    }
    expect(navigation).toBeLessThan(device)
    expect(device).toBeLessThan(rotate)
    expect(rotate, 'rotate leaves the device in a condition, so it closes the Device group')
      .toBeLessThan(capture)
    expect(capture).toBeLessThan(environment)
  })

  it('exists in the accessibility tree, not only as a line on screen', () => {
    // **The dividers are `<div>`s with a background colour.** Without a role and a name the four
    // groups this whole change is about are, to a screen reader or voice control, one flat run of
    // icon buttons — and the order assertion above would pass over exactly that.
    toolbar()
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['Navigation', 'Device', 'Capture', 'Environment'])
  })

  it('closes the Device group with the restart, after rotate', () => {
    // A restart acts on the device like the power button does, and a group runs frequent → rare, so
    // it is the last thing in Device rather than the first (#628, and the rule in
    // `packages/dashboard/AGENTS.md`). Asserted as *last in its own group* rather than as an index,
    // because an index moves whenever a platform hands the group another button.
    toolbar()
    const device = within(screen.getByRole('group', { name: 'Device' }))
    const names = device.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '')
    expect(names, 'the restart is not in the Device group at all').toContain('Restart the device')
    expect(names.at(-1), 'something was placed after the restart').toBe('Restart the device')
  })

  it('puts each button in the group the rule assigns it to', () => {
    // Order alone does not say which side of a boundary a button is on. This is what fails when a
    // button drifts one group over — which is the change the rule exists to make a decision.
    toolbar()
    const group = (name: string) => within(screen.getByRole('group', { name }))
    expect(group('Navigation').getByRole('button', { name: /Launch app/ })).toBeTruthy()
    expect(group('Navigation').getByRole('button', { name: /^Home$/ })).toBeTruthy()
    expect(group('Navigation').getByRole('button', { name: /deeplink/i })).toBeTruthy()
    expect(group('Device').getByRole('button', { name: /Software keyboard/ })).toBeTruthy()
    expect(group('Device').getByRole('button', { name: /Rotate/ })).toBeTruthy()
    expect(group('Capture').getByRole('button', { name: /screenshot/i })).toBeTruthy()
    expect(group('Environment').getByRole('button', { name: /device (offline|online|network)/i })).toBeTruthy()
  })

  it('draws no Environment boundary when the agent cannot control the network', () => {
    // A named group with nothing in it announces a section that holds nothing, and the separator
    // announces a boundary to it. Both go with the control.
    toolbar({ network: false })
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))
    expect(groups, 'an empty Environment group was announced').toEqual(['Navigation', 'Device', 'Capture'])
    expect(screen.queryAllByRole('separator'), 'a separator was left pointing at nothing').toHaveLength(2)
  })

  it('separates the groups with separators, not with bare lines', () => {
    // Three groups' worth of boundary. Without a role these are `<div>`s with a background colour and
    // the structure exists only for people who can see it.
    toolbar()
    const separators = screen.getAllByRole('separator')
    expect(separators).toHaveLength(3)
    // Orientation too: `getAllByRole('separator')` matches on the role alone, so one claiming to be
    // vertical inside a column toolbar was green.
    for (const s of separators) expect(s.getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('keeps the deeplink in Navigation rather than with the tools', () => {
    // From the tester's side this is "go to this screen", not "type a URL" — the one placement the
    // issue called out as genuinely arguable, so it is the one worth pinning.
    toolbar()
    const at = positions()
    expect(at(/deeplink/i)).toBeGreaterThan(at(/^Home$/))
    expect(at(/deeplink/i), 'the deeplink drifted into Capture').toBeLessThan(at(/screenshot/i))
  })

  it('puts the network control last, alone in Environment', () => {
    toolbar()
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '')
    expect(names.at(-1), 'Environment is the last group and the network control is its only member')
      .toMatch(/device (offline|online|network)/i)
  })
})

describe('restarting the device asks first', () => {
  // The device does not come back the way it left, and the tester may have spent ten minutes getting
  // it into the state they are about to lose. Both halves are tested: a dialog that always confirms
  // is the same as no dialog.
  it('does not restart on the click that opens the dialog', async () => {
    const onReboot = vi.fn()
    toolbar({ onReboot })
    await userEvent.click(screen.getByRole('button', { name: 'Restart the device' }))
    expect(screen.getByRole('alertdialog'), 'no confirmation was raised').toBeTruthy()
    expect(onReboot, 'the device restarted before anyone confirmed').not.toHaveBeenCalled()
  })

  it('restarts nothing when the dialog is dismissed', async () => {
    const onReboot = vi.fn()
    toolbar({ onReboot })
    await userEvent.click(screen.getByRole('button', { name: 'Restart the device' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onReboot).not.toHaveBeenCalled()
  })

  it('restarts once when it is confirmed', async () => {
    const onReboot = vi.fn()
    toolbar({ onReboot })
    await userEvent.click(screen.getByRole('button', { name: 'Restart the device' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(onReboot).toHaveBeenCalledTimes(1)
  })

  it('shows the same words it answers to', async () => {
    // WCAG 2.5.3: the visible label has to be contained in the accessible name, or voice control
    // saying what is on screen misses the button. These were two literals — "Restart device" against
    // "Restart the device" — and they disagreed outright while pending, when the name changed and the
    // tooltip did not.
    toolbar()
    const button = screen.getByRole('button', { name: 'Restart the device' })
    await userEvent.hover(button)
    const tip = await screen.findByRole('tooltip')
    expect(button.getAttribute('aria-label'), 'the visible label is not part of the name')
      .toContain(tip.textContent)
  })

  it('cannot be pressed again while a restart is running', async () => {
    // `aria-disabled` rather than `disabled`, so the control keeps its place in the tab order and
    // stays describable — which means the guard has to be in the handler, and this is what holds it.
    const onReboot = vi.fn()
    render(
      <SimulatorToolbar
        joined onScreenshot={() => {}} onRecordToggle={() => {}} recordState="idle"
        onRotate={() => {}} onDeepLink={() => {}}
        reboot={{ pending: true, onReboot }}
      />,
    )
    const button = screen.getByRole('button', { name: 'Restarting the device' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    // Through `userEvent`, not `button.click()`. The raw DOM call leaves React's state update
    // unflushed at the assertion, so the dialog reads as absent whether the guard is there or not —
    // measured: deleting the guard changed nothing until this line did.
    await userEvent.click(button)
    expect(screen.queryByRole('alertdialog'), 'a busy control still opened the dialog').toBeNull()
    expect(onReboot).not.toHaveBeenCalled()
  })
})
