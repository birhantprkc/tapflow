// The record button while a recording is being processed and once it is saved (#624).
//
// Both states used `disabled`, which takes the button out of the tab order the moment a keyboard
// user activates "Stop recording" — focus drops to `<body>`, and the name that changes to say what
// happened is announced to nobody. The button now stays focusable and refuses the click itself, and
// a live region beside it carries the outcome.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SimulatorToolbar } from '@/components/device/shared/SimulatorToolbar'

type RecordState = 'idle' | 'recording' | 'uploading' | 'done'

function toolbar(recordState: RecordState, onRecordToggle = vi.fn()) {
  const props = {
    joined: true,
    onScreenshot: () => {},
    onRotate: () => {},
    onDeepLink: () => {},
    reboot: { pending: false, onReboot: () => {} },
  }
  const view = render(<SimulatorToolbar {...props} recordState={recordState} onRecordToggle={onRecordToggle} />)
  return {
    onRecordToggle,
    rerender: (next: RecordState) =>
      view.rerender(<SimulatorToolbar {...props} recordState={next} onRecordToggle={onRecordToggle} />),
  }
}

const record = () => screen.getByRole('button', { name: /recording|Recording saved/ })

/** The region the button points at, rather than any `status` on the page — the toolbar has three. */
function statusOf(button: HTMLElement) {
  const id = button.getAttribute('aria-describedby')
  expect(id, 'the button describes itself through nothing').toBeTruthy()
  return document.getElementById(id!)!
}

describe('the record button while the recording is processed', () => {
  it.each(['uploading', 'done'] as const)('stays in the tab order while %s', (state) => {
    toolbar(state)
    const button = record()
    expect(button.hasAttribute('disabled'), 'a disabled button cannot hold focus').toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps focus through stop, processing and saved', () => {
    const { rerender } = toolbar('recording')
    record().focus()
    rerender('uploading')
    expect(record()).toHaveFocus()
    rerender('done')
    expect(record()).toHaveFocus()
  })

  it('is busy while processing and not once saved', () => {
    const { rerender } = toolbar('uploading')
    expect(record().getAttribute('aria-busy')).toBe('true')
    rerender('done')
    expect(record().getAttribute('aria-busy')).toBe('false')
  })

  it.each(['uploading', 'done'] as const)('refuses a click while %s', async (state) => {
    // The guard is the only thing stopping the click now that the DOM does not, so it is what has to
    // be asserted. Through `userEvent`, which honours `aria-disabled` the way a real click does not.
    const { onRecordToggle } = toolbar(state)
    await userEvent.click(record())
    expect(onRecordToggle, `a click went through while ${state}`).not.toHaveBeenCalled()
  })

  it.each(['idle', 'recording'] as const)('still toggles while %s', async (state) => {
    const { onRecordToggle } = toolbar(state)
    await userEvent.click(record())
    expect(onRecordToggle).toHaveBeenCalledTimes(1)
  })
})

describe('the recording outcome is announced', () => {
  it('through a live region that outlives every state', () => {
    // Mounted with the button and empty while idle: a region inserted together with its first
    // sentence is routinely dropped by AT, which would silence the one transition it exists for.
    const { rerender } = toolbar('idle')
    const region = statusOf(record())
    expect(region.getAttribute('role')).toBe('status')
    expect(region.textContent).toBe('')

    rerender('recording')
    expect(statusOf(record())).toBe(region)
    expect(region.textContent).toBe('Recording.')

    rerender('uploading')
    expect(statusOf(record())).toBe(region)
    expect(region.textContent).toBe('Processing the recording.')

    rerender('done')
    expect(statusOf(record())).toBe(region)
    expect(region.textContent).toBe('Recording saved.')

    rerender('idle')
    expect(statusOf(record())).toBe(region)
    expect(region.textContent).toBe('')
  })
})
