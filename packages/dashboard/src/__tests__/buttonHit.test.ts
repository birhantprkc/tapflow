// Which physical side button a press lands on. The defect this covers was found by hand on a real
// simulator (2026-09-11): on an iPhone 15 Pro the upper half of Volume Up pressed the **Action**
// button — the tooltip said Action and the press followed it.
//
// Two things were wrong together, and the fixtures below separate them because fixing only the
// first leaves the second:
//
//   1. catchment was a fixed radius around each button's *centre*, so a tall button's own pixels
//      could sit nearer a short neighbour's centre;
//   2. the *first* button within range won, not the nearest — so the whole overlap band went to
//      whichever button `chrome.buttons` happened to list earlier.
//
// Every case names the mutation that kills it.
import type { ChromeButton } from '@tapflowio/protocol'
import { describe, expect, it } from 'vitest'
import { buttonHitRect, distanceToRect, pickButton } from '../../lib/buttonHit'

const MARGIN = 100

/** 2× composite px, shaped like an iPhone 15 Pro's left edge: Action above a much taller Volume Up. */
const button = (name: string, centreY: number, h: number, anchor = 'left'): ChromeButton => ({
  name,
  accessibilityTitle: name,
  anchor,
  onTop: false,
  normalOffset: { x: 40, y: centreY },
  rolloverOffset: { x: 40, y: anchor === 'top' ? centreY : centreY },
  buttonW: 24,
  buttonH: h,
  usagePage: 0,
  usage: 0,
})

//                        rect
const ACTION = button('action', 620, 110)      // 565 … 675
const VOLUME_UP = button('volume_up', 850, 280) // 710 … 990
const BUTTONS = [ACTION, VOLUME_UP] as const    // Action first — the order that used to decide

describe('buttonHitRect', () => {
  it('places a side button around its normal centre', () => {
    expect(buttonHitRect(ACTION)).toEqual({ left: 28, top: 565, right: 52, bottom: 675 })
  })

  // Mutation: measure every anchor from `normalOffset.y`. The home button's rect moves by half its
  // height and the target stops matching the pixels it is drawn on.
  it('measures a top-anchored button from its rollover offset', () => {
    const home = button('home', 1400, 90, 'top')
    expect(buttonHitRect(home).top).toBe(1400)
  })
})

describe('distanceToRect', () => {
  // Mutation: return the distance to the rect's centre instead. Nothing scores 0 any more and a
  // press inside a button can lose to a neighbour.
  it('is zero anywhere inside', () => {
    expect(distanceToRect(40, 715, buttonHitRect(VOLUME_UP))).toBe(0)
    expect(distanceToRect(40, 989, buttonHitRect(VOLUME_UP))).toBe(0)
  })

  it('measures from the nearest edge, not the centre', () => {
    expect(distanceToRect(40, 705, buttonHitRect(VOLUME_UP))).toBe(5)
    expect(distanceToRect(40, 675 + 40, buttonHitRect(ACTION))).toBe(40)
  })
})

describe('pickButton — the defect found on the simulator', () => {
  // y=715 is inside Volume Up, 40 below Action's bottom edge — and **nearer Action's centre**
  // (95) than Volume Up's (135). So this one case kills both the old rule and a half-fix that
  // only switches first-match to nearest-*centre*.
  //
  // Mutation A (the original): `for (…) if (dist(centre) < MARGIN) return btn.name` → 'action'.
  // Mutation B (half-fix): nearest by centre distance → 'action'.
  it('presses the button the point is inside, not the neighbour whose centre is closer', () => {
    expect(pickButton(40, 715, BUTTONS, MARGIN)).toBe('volume_up')
  })

  // Mutation: take the first match rather than the nearest. Action is listed first and its margin
  // reaches here, so it wins the whole band.
  it('splits the gap between two buttons at the midpoint', () => {
    // Action ends at 675, Volume Up starts at 710 — the midline is 692.5.
    expect(pickButton(40, 680, BUTTONS, MARGIN)).toBe('action')
    expect(pickButton(40, 705, BUTTONS, MARGIN)).toBe('volume_up')
  })

  it('still presses a button from just outside it, so targets stay generous', () => {
    expect(pickButton(40, 565 - 99, BUTTONS, MARGIN)).toBe('action')
    expect(pickButton(40, 990 + 99, BUTTONS, MARGIN)).toBe('volume_up')
  })

  // Mutation: drop the `best <= margin` test and return `hit`. Every press anywhere on the page
  // that reaches this code presses whichever button is least far away.
  it('presses nothing beyond the margin', () => {
    expect(pickButton(40, 990 + 101, BUTTONS, MARGIN)).toBeNull()
    expect(pickButton(4000, 715, BUTTONS, MARGIN)).toBeNull()
  })

  // Mutation: `<=` instead of `<` when comparing distances. The later button wins ties, reversing
  // the documented rule — invisible in every other case here.
  it('gives an exact tie to the earlier button', () => {
    const a = button('a', 500, 100) // 450 … 550
    const b = button('b', 700, 100) // 650 … 750
    expect(pickButton(40, 600, [a, b], MARGIN)).toBe('a')
  })

  it('presses nothing when the device has no buttons', () => {
    expect(pickButton(40, 715, [], MARGIN)).toBeNull()
  })
})
