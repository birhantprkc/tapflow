import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SimulatorToolbar, type NetworkControl } from '@/components/device/shared/SimulatorToolbar'

type RecordState = 'idle' | 'recording' | 'uploading' | 'done'

function toolbar(network?: NetworkControl, recordState: RecordState = 'idle') {
  return render(
    <SimulatorToolbar
      joined
      onScreenshot={() => {}}
      onRecordToggle={() => {}}
      recordState={recordState}
      onRotate={() => {}}
      onDeepLink={() => {}}
      network={network}
    />,
  )
}

const control = (over: Partial<NetworkControl> = {}): NetworkControl =>
  ({ position: 'online', steerable: true, pending: false, onToggle: () => {}, ...over })

/** The button, found by whichever action its current position offers. */
const networkButton = () =>
  screen.queryByRole('button', { name: /(device (offline|online|network)|^Retry: )/ })

/** The region the button points at: the record button carries its own `status` beside this one. */
const networkStatus = () =>
  document.getElementById(networkButton()!.getAttribute('aria-describedby')!)!

/** What the button is called in a given position — read from the render, not restated here. */
function networkButtonName(position: NetworkControl['position']) {
  const { unmount } = toolbar(control({ position }))
  const name = networkButton()!.getAttribute('aria-label')
  unmount()
  return name
}

describe('SimulatorToolbar — the record button it sits beside', () => {
  it('says what each of its four states is, including the two that disable it', () => {
    // A disabled button suppresses pointer events, so Radix never opens its tooltip and never
    // attaches the description — the same #447 gap the network control is built around. While
    // uploading it announced "Start recording, unavailable": the wrong action, and no reason.
    //
    // Mutation: branching the label on `recording` alone fails here.
    const named = (recordState: RecordState) => {
      const { unmount } = toolbar(undefined, recordState)
      const name = screen.getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
        .find((n) => n && /record/i.test(n))
      unmount()
      return name
    }
    const names = (['idle', 'recording', 'uploading', 'done'] as const).map(named)
    expect(names.every(Boolean), 'a record state has no name').toBe(true)
    expect(new Set(names).size, 'two record states share a name').toBe(4)
  })
})

describe('SimulatorToolbar — network control', () => {
  it('renders nothing when the agent did not say it could do this', () => {
    // The gate, and the control for every assertion below: without it they pass on a toolbar that
    // renders the button unconditionally, which is the shape #447 exists to prevent — a control
    // offered for an agent that has no code behind it.
    //
    // Mutation: rendering the block without the `network &&` guard fails here.
    toolbar(undefined)
    expect(networkButton()).toBeNull()
    // …and the rest of the toolbar is unaffected, so this is not passing on an empty render.
    expect(screen.getByRole('button', { name: /rotate/i })).toBeTruthy()
  })

  it('renders when it did', () => {
    toolbar(control())
    expect(networkButton()).toBeTruthy()
  })

  it('names the action rather than the state, and never offers the one already done', () => {
    // A name that said the state ("Device is offline") never tells the user what clicking does, and a
    // fixed action name offers "Take device offline" to a device that already is. The name is the
    // action available *from here*.
    //
    // Mutation: a constant label fails the offline case.
    const named = (position: NetworkControl['position']) => {
      const { unmount } = toolbar(control({ position }))
      const name = networkButton()!.getAttribute('aria-label')
      unmount()
      return name
    }
    expect(named('offline')).toBe('Bring device online')
    expect(named('online')).toBe('Take device offline')
  })

  it('puts no direction in the name of a state it could not read', () => {
    // **The same claim-from-silence, one channel over.** "Take device offline" asserts the device is
    // currently online, which is what `aria-pressed={false}` was dropped for — moving it from the
    // state into the name does not stop it being that claim. The pulse and the muted colour say "we
    // do not know" to anyone who can see them; this says it to everyone else, and unlike the
    // description beside it a name cannot be silenced by a verbosity setting.
    //
    // Mutation: falling back to 'Take device offline' for these two fails here.
    for (const position of ['waiting', 'unknown'] as const) {
      const { unmount } = toolbar(control({ position }))
      expect(networkButton()!.getAttribute('aria-label'), position).toBe('Toggle device network')
      unmount()
    }
  })

  it('announces every position, including the ones that went well', () => {
    // Two failures in one. A live region **inserted** with its first sentence is routinely dropped by
    // NVDA, JAWS and VoiceOver, and a region that **empties** on success announces nothing — so the
    // request was announced starting and never announced finishing, with the failure path the only
    // one that spoke. A name change on an already-focused button does not reliably carry it either.
    //
    // Mutation: clearing the text for `online`/`offline`, or mounting the span only when it has
    // something to say, fails here.
    const said = (position: NetworkControl['position'], pending = false) => {
      const { unmount } = toolbar(control({ position, pending }))
      const text = networkStatus().textContent
      unmount()
      return text
    }
    const sentences = (['online', 'offline', 'waiting', 'unknown'] as const).map((p) => said(p))
    expect(sentences.every((t) => t && t.trim().length > 0), 'a position says nothing').toBe(true)
    expect(new Set(sentences).size, 'two positions say the same thing').toBe(4)
    expect(said('online', true)).toMatch(/changing/i)
  })

  it('describes each toolbar with its own element', () => {
    // Two viewers on screen would otherwise point both buttons at the first span, so one device's
    // control would be described by another device's network state.
    //
    // Mutation: a literal id makes both ids equal and fails here.
    const { container: a } = toolbar(control({ position: 'unknown' }))
    const { container: b } = toolbar(control({ position: 'waiting' }))
    const idOf = (root: HTMLElement) =>
      root.querySelector('[aria-describedby]')!.getAttribute('aria-describedby')
    expect(idOf(a)).not.toBe(idOf(b))
  })

  it('says nothing about pressedness, in either direction', () => {
    // **`aria-pressed` was tried and dropped.** The name already carries the state as an action, so
    // adding it says the same fact in two grammars — and `false` in the two positions this design
    // refuses to draw would assert the device is on the network, which is the claim the whole thing
    // exists to avoid making from silence.
    //
    // Mutation: `aria-pressed={position === 'offline'}` fails here.
    for (const position of ['online', 'offline', 'waiting', 'unknown'] as const) {
      const { unmount } = toolbar(control({ position }))
      expect(networkButton()!.getAttribute('aria-pressed'), position).toBeNull()
      unmount()
    }
  })

  it('shows the action in the tooltip too, so what is said matches what is read', async () => {
    // WCAG 2.5.3: the visible label has to contain the accessible name, or a voice-control user says
    // what they see and hits nothing. The status is appended rather than substituted for it.
    //
    // Mutation: rendering `status` alone in the tooltip fails here.
    toolbar(control({ position: 'unknown' }))
    // Radix keeps `TooltipContent` out of the DOM until it opens, so this has to hover rather than
    // query — a `getByText` here would assert on a node that never exists and fail for the wrong reason.
    await userEvent.hover(networkButton()!)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toContain('Toggle device network')
    expect(tip.textContent).toContain('No network state has been reported')
  })

  it('describes every position with the sentence for that position', () => {
    // **Every position is described, including the settled ones** — an earlier version of this comment
    // said the opposite and named a mutation that was the shipped code, which is the defect
    // `test-and-guard-coverage.md` §1 is about. The description is the only channel that reaches
    // touch: Radix attaches a tooltip's own `aria-describedby` only while it is open.
    //
    // The id has to resolve to *that position's* sentence, not merely to something. Checking only
    // that an element exists would pass on a span that repeated the button's name, leaving the state
    // said nowhere.
    //
    // Mutation: pointing `aria-describedby` at a span that is not rendered, or rendering the label
    // there instead of the status, fails here.
    // **The id and the text, not the text alone.** An earlier version resolved the attribute through
    // `getElementById` and returned `null` when it pointed at nothing — so a control that always
    // carried `aria-describedby`, dangling at an element that is not rendered, read as having none.
    // AT announces a dangling reference as no description, which is the same *outcome* and a
    // different defect; the mutation that produced it survived until this looked at both.
    const described = (position: NetworkControl['position']) => {
      const { unmount } = toolbar(control({ position }))
      const id = networkButton()!.getAttribute('aria-describedby')
      const text = id === null ? null : document.getElementById(id)?.textContent ?? '<dangling>'
      unmount()
      return { id, text }
    }
    const seen = new Set<string>()
    for (const p of ['online', 'offline', 'waiting', 'unknown'] as const) {
      const { id, text } = described(p)
      expect(id, `${p} is described by nothing`).not.toBeNull()
      expect(text, `${p} is described by an element that is not there`).not.toBe('<dangling>')
      expect(text, `${p} is described by its own name rather than its state`)
        .not.toBe(networkButtonName(p))
      seen.add(text ?? '')
    }
    expect(seen.size, 'two positions are described the same way').toBe(4)
  })

  it('still shows where the device is when tapflow can no longer move it', () => {
    // **The ratchet this replaced.** `available: false` means "cannot change it", not "cannot read
    // it" — the protocol carries `offline` on that member for exactly this — and an earlier draft
    // rendered it as a position-less state. From there every click asked for offline again, so a
    // device taken offline on a write that could not be confirmed could not be brought back.
    //
    // Mutation: rendering `steerable: false` as `unknown` fails here.
    //
    // `state-unconfirmed` is the reason the paragraph above is literally about — a write that could
    // not be confirmed — and it is the one where a retry can still land.
    const { unmount } = toolbar(control({ position: 'offline', steerable: false, reason: 'state-unconfirmed' }))
    // The name says the direction **and** that the last attempt did not land. Putting the caveat only
    // in the description would leave it to a channel a verbosity setting can drop.
    expect(networkButton()!.getAttribute('aria-label')).toBe('Retry: bring device online')
    const id = networkButton()!.getAttribute('aria-describedby')!
    expect(document.getElementById(id)!.textContent).toContain('offline')
    expect(document.getElementById(id)!.textContent).toContain('try again')
    unmount()
  })

  it('does not offer a retry for a reason a retry cannot fix', () => {
    // **The prefix's own justification was conditional and the condition has expired.** It read "not
    // futile *while #618 leaves a transient failure indistinguishable from a permanent one*" — and
    // #618 split them. A device that was read and had not moved, and a Mac that is not set up for
    // this, are both states where clicking again does exactly nothing.
    // And what replaces it is a marker in the **name**, not the colour. Leaving the plain actionable
    // name there put the whole "this will not work" on a channel a screen-reader user does not have,
    // with the description — which a verbosity setting can drop — as the only other one.
    for (const reason of ['filter-unavailable', 'not-armed', 'hooks-not-installed', 'enforcement-lost'] as const) {
      const { unmount } = toolbar(control({ position: 'online', steerable: false, reason }))
      const name = networkButton()!.getAttribute('aria-label')
      expect(name, `reason ${reason} offered a retry`).not.toMatch(/^Retry:/)
      expect(name, `reason ${reason} left the failure to the colour alone`).toBe('Take device offline — unavailable')
      unmount()
    }
  })

  it('says what to do about it, one sentence per reason', () => {
    // A member per thing a consumer must do differently is what the closed set is *for*, so each
    // sentence has to be the one that belongs to its reason — and none of them may name the machinery.
    // A tester is not going to install a system extension; what they can do is launch an app, restart
    // a device, try again, or go and ask whoever runs the Mac.
    //
    // **Pinned to the actual words, because counting them did not work.** A first version asserted
    // only "not the bare status", "no implementation nouns", and "seven distinct strings" — under
    // which deleting any single `case` and letting it fall through to `default` still passed all
    // three, including for the one reason whose destination the protocol declares mandatory.
    const expected = [
      ['awaiting-app', /launch an app/i],
      ['not-armed', /restart the device/i],
      ['state-unconfirmed', /try again/i],
      ['unsupported-device', /did not change when tapflow asked/i],
      ['filter-unavailable', /not set up .* network control guide/i],
      ['enforcement-lost', /went back on the network on its own/i],
      ['hooks-not-installed', /cannot tell this app/i],
    ] as const
    const seen = new Set<string>()
    for (const [reason, fragment] of expected) {
      const { unmount } = toolbar(control({ position: 'online', steerable: false, reason }))
      const id = networkButton()!.getAttribute('aria-describedby')!
      const text = document.getElementById(id)!.textContent ?? ''
      expect(text, `reason ${reason} did not say its own sentence`).toMatch(fragment)
      expect(text, `reason ${reason} names the machinery`).not.toMatch(/filter|extension|hook|dylib|kernel/i)
      seen.add(text)
      unmount()
    }
    expect(seen.size, 'two reasons are described the same way').toBe(expected.length)
  })

  it('marks an unconfirmed state with the pulse, and nothing else with it', () => {
    // The pulse is the whole of how uncertainty is said. Rendering it as a position of `unknown` was
    // tried and reverted — from there every click asks for offline again, so a device taken offline
    // could not be brought back — and this is what replaced it. Nothing asserted it, so the line could
    // be deleted with the suite green and the reverted design's only replacement gone with it.
    const classesFor = (reason: NetworkControl['reason']) => {
      const { unmount } = toolbar(control({ position: 'offline', steerable: false, reason }))
      const cls = networkButton()!.className
      unmount()
      return cls
    }
    expect(classesFor('state-unconfirmed')).toMatch(/animate-pulse/)
    expect(classesFor('filter-unavailable'), 'a settled failure must not pulse').not.toMatch(/animate-pulse/)
  })

  it('renders a reason it has never heard of rather than nothing', () => {
    // Agents update on their own schedule, so a build older than the agent talking to it has to draw
    // *something*. The `default` branch says the one thing true of every member without guessing.
    const { unmount } = toolbar(control({
      position: 'online', steerable: false,
      reason: 'future-member' as NetworkControl['reason'],
    }))
    const id = networkButton()!.getAttribute('aria-describedby')!
    expect(document.getElementById(id)!.textContent).toContain('cannot change it right now')
    unmount()
  })

  it('leaves the button usable in every position, including the ones it cannot read', () => {
    // **The #447 resolution.** A disabled control owes a reason it cannot give here, and an absent one
    // cannot come back: the click is the only thing that produces a fresh `network:state`, so hiding
    // the control when the state goes unreadable would strand the session. Staying clickable is what
    // makes `unknown` a position to work from rather than a dead end.
    //
    // Mutation: `disabled={position === 'unknown'}` fails here.
    for (const position of ['online', 'offline', 'waiting', 'unknown'] as const) {
      const { unmount } = toolbar(control({ position }))
      expect((networkButton() as HTMLButtonElement).disabled, position).toBe(false)
      unmount()
    }
  })

  it('marks the control busy while it refuses clicks', () => {
    // `toggle` returns early for as long as this lasts — up to `NETWORK_REQUEST_DEADLINE_MS`, eight
    // seconds — and neither the swapped icon nor the one-shot live sentence is a property AT can
    // query on the control itself.
    //
    // Mutation: removing `aria-busy` fails here.
    const { unmount } = toolbar(control({ pending: true }))
    expect(networkButton()!.getAttribute('aria-busy')).toBe('true')
    // …and says it is refusing, which `aria-busy` alone does not: NVDA, JAWS and VoiceOver do not
    // read that as unavailability on a button.
    //
    // Mutation: removing `aria-disabled` fails here.
    expect(networkButton()!.getAttribute('aria-disabled')).toBe('true')
    // Not `disabled`, which would drop focus and suppress the tooltip — #624's shape.
    expect((networkButton() as HTMLButtonElement).disabled).toBe(false)
    unmount()
    toolbar(control({ pending: false }))
    expect(networkButton()!.getAttribute('aria-busy')).toBe('false')
  })

  it('does not say a retry failed where nothing was ever attempted', () => {
    // `steerable: false` means a report came back saying tapflow can no longer move it. A
    // position-less state has had no report, so "Retry" there asserts an attempt that no channel
    // explains. Unreachable through the hook — any report settles the position — but this component
    // takes the two as independent props.
    //
    // Mutation: prefixing unconditionally fails here.
    for (const position of ['waiting', 'unknown'] as const) {
      const { unmount } = toolbar(control({ position, steerable: false }))
      expect(networkButton()!.getAttribute('aria-label'), position).toBe('Toggle device network')
      unmount()
    }
  })

  it('passes the click through', async () => {
    const onToggle = vi.fn()
    toolbar(control({ onToggle }))
    await userEvent.click(networkButton()!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('refuses the click it says it is refusing', async () => {
    // `aria-disabled` announced unavailability while the guard lived in the hook — a state in ARIA
    // and not in behaviour, which is the mirror of a state in CSS and not in ARIA. Voice-control
    // implementations that skip `aria-disabled` targets would have been told one thing while any
    // consumer wiring a handler without its own guard fired the action.
    //
    // Mutation: `onClick={network.onToggle}` fails here.
    const onToggle = vi.fn()
    toolbar(control({ onToggle, pending: true }))
    await userEvent.click(networkButton()!)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('keeps its name while a request is in flight', async () => {
    // The spinner replaces the icon, not the label — an icon-only control that loses its accessible
    // name mid-request is unreachable for the duration.
    toolbar(control({ position: 'offline', pending: true }))
    expect(networkButton()).toBeTruthy()
  })

  // Every position that carries a colour has to survive being pointed at. The `ghost` variant sets
  // `hover:text-accent-foreground`, so a state class with no hover of its own is repainted as an
  // ordinary enabled button — the state disappears exactly while someone is looking at it. `offline`
  // defended itself from the start and the three muted positions did not, which is why this asserts
  // over the whole set rather than the one that was reported.
  //
  // Mutation: dropping `hover:` from any single position fails here.
  it.each([
    ['online, not steerable', control({ steerable: false })],
    ['online, waiting for an app', control({ steerable: false, reason: 'awaiting-app', position: 'offline' })],
    ['waiting', control({ position: 'waiting' })],
    ['unknown', control({ position: 'unknown' })],
    ['offline', control({ position: 'offline' })],
    ['offline, not steerable', control({ position: 'offline', steerable: false })],
  ])('pins its colour against hover: %s', (_name, c) => {
    const { unmount } = toolbar(c)
    const cls = networkButton()!.className
    const colour = cls.split(/\s+/).find(t => /^text-(muted-foreground|destructive|amber-500(\/\d+)?)$/.test(t))
    expect(colour, `no state colour in "${cls}"`).toBeTruthy()
    expect(cls).toContain(`hover:${colour}`)
    unmount()
  })

  describe('waiting for an app to run under the injection', () => {
    // The state every iOS session is in between the device coming up and its app starting. It arrives
    // inside `steerable: false`, and everything below is about it not being drawn like the failures
    // that share that flag: traffic control works here, so a dead-looking control says the opposite
    // of what a click does.
    const awaiting = (over: Partial<NetworkControl> = {}) =>
      control({ steerable: false, reason: 'awaiting-app', ...over })

    it('is not painted as a failure', () => {
      const { unmount } = toolbar(awaiting())
      const cls = networkButton()!.className
      expect(cls).not.toContain('text-destructive')
      expect(cls).not.toContain('text-muted-foreground')
      unmount()
    })

    it('still paints an offline device amber, because it really is offline', () => {
      toolbar(awaiting({ position: 'offline' }))
      expect(networkButton()!.className).toContain('text-amber-500')
    })

    it('says what is missing rather than that nothing can be done', () => {
      toolbar(awaiting())
      // "tapflow can no longer change it" was wrong twice here: nothing had been armed, so there was
      // no "no longer", and clicking does change the device.
      const said = networkStatus().textContent ?? ''
      expect(said).toContain('Launch an app')
      expect(said).not.toContain('no longer')
    })

    it('keeps the plain action name, because this is not a failed attempt', () => {
      toolbar(awaiting())
      expect(networkButton()!.getAttribute('aria-label')).toBe('Take device offline')
    })

    it('leaves the real failures painted as failures', () => {
      // The contrast that makes the colour mean something: same `steerable: false`, a reason that is
      // not `awaiting-app`.
      toolbar(control({ steerable: false }))
      expect(networkButton()!.className).toContain('text-destructive')
    })
  })

  /** The state colour a position renders with, or undefined if it has none. */
  const stateColour = (c: NetworkControl) => {
    const { unmount } = toolbar(c)
    const found = networkButton()!.className.split(/\s+/)
      .find(t => /^text-(muted-foreground|destructive|amber-500)(\/\d+)?$/.test(t))
    unmount()
    return found
  }

  it('paints an unsteerable control the same way at both settled positions', () => {
    // It was red at `online` and amber at 60% at `offline`. The faint half is the defect this control
    // was already sent back for once: a washed-out icon reads as a disabled button, and this button
    // still works.
    //
    // Mutation: restoring `text-amber-500/60` at the offline position fails here, and so does
    // dropping the failure colour from either position.
    const online = stateColour(control({ steerable: false }))
    const offline = stateColour(control({ position: 'offline', steerable: false }))
    expect(online).toBe('text-destructive')
    expect(offline).toBe(online)
  })

  it.each(['waiting', 'unknown'] as const)('leaves %s muted, steerable or not', (position) => {
    // **The other two positions do not take the failure colour, and that is the rule rather than an
    // omission.** `networkAction` already refuses to prefix `Retry:` here, for a reason it states:
    // a position-less state has had no attempt, so claiming a failed one asserts something no
    // channel can explain. Painting it as a failure would make exactly that claim in colour — on the
    // opening seconds of a session, where it would be the first thing a tester sees.
    //
    // There was no case in this file pairing either position with `steerable: false`, so a reading of
    // "one rule, every position" that added `FAILED` to the switch's other two branches would have
    // been green — and would have produced a red button named "Toggle device network".
    expect(stateColour(control({ position }))).toBe('text-muted-foreground')
    expect(stateColour(control({ position, steerable: false }))).toBe('text-muted-foreground')
  })

  it('keeps a visual channel for the position when both look like failures', () => {
    // With one colour for "unsteerable" at both settled positions, the icon is the ONLY channel left
    // that separates offline from online for a sighted mouse or touch user — the status sentence is
    // `sr-only` and the tooltip does not open on touch.
    //
    // So it is asserted rather than assumed. Nothing else in this file would notice `RadioOff` being
    // unified with `Radio`.
    const svg = (c: NetworkControl) => {
      const { unmount } = toolbar(c)
      const html = networkButton()!.querySelector('svg')!.outerHTML
      unmount()
      return html
    }
    expect(svg(control({ position: 'offline', steerable: false })))
      .not.toBe(svg(control({ position: 'online', steerable: false })))
  })

  it('draws no position faint', () => {
    // The whole reason the rule above exists. A `/60` on any state colour is the rendering a tester
    // reads as "this button is disabled", and none of these four is.
    //
    // Mutation: any single position reintroducing an opacity suffix fails here.
    const colours = ([
      control({ steerable: false }),
      control({ position: 'offline', steerable: false }),
      control({ position: 'offline' }),
      control({ position: 'waiting' }),
      control({ position: 'unknown' }),
    ]).map(stateColour)
    expect(colours.every(Boolean), 'a position has no state colour').toBe(true)
    expect(colours.filter(c => c?.includes('/'))).toEqual([])
  })

  it('leaves hover alone where there is no state colour to protect', () => {
    // The settled, steerable position is drawn like every other button in the toolbar, so it should
    // take the variant's hover exactly as they do. Pinning it here would be the opposite defect:
    // a control that looks inert while it is the one thing fully working.
    toolbar(control())
    expect(networkButton()!.className).not.toContain('hover:text-muted-foreground')
  })
})
