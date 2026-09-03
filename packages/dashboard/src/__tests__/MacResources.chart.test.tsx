import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AreaChartInner } from '@/src/pages/MacResources'

// **The series is clipped to the plot, and this is what says so.** The window runs `now - interval` to
// `now`, and the samples inside it are selected by the relay from *its* clock — two clocks that are only
// ever approximately equal. A relay running behind returns points older than the window's left edge, and
// `scaleTime` does not clamp: they map to a negative x and the area paints straight through the tick
// labels. It showed worst on RAM, which sits at ~57% right where "50%" and "25%" are.
//
// **This used to rest on the window reaching past the data rather than the other way round.** The right
// edge was rounded up to a clean tick (`ceil(now / step) * step`), which pushed the left edge a full step
// later than the oldest sample the relay returns. That round-up is gone — it also put the axis up to a
// step into the future, which is what the block below measures. The clip is still load-bearing; what
// reaches past the plot is now the data.
//
// Rendered directly rather than through the page: `ParentSize` measures 0 in jsdom, so `ChartCard` renders
// nothing there and a test of the page would assert against an empty div.

const AT = Date.parse('2026-08-18T02:55:00.000Z')

/** How far the relay's clock trails the dashboard's — the reason a sample can precede the window. */
const RELAY_LAG_MS = 5 * 60_000

/** One sample per minute across the relay's last hour, which begins before the dashboard's window does. */
const series = Array.from({ length: 60 }, (_, i) => {
  const t = AT - RELAY_LAG_MS - (59 - i) * 60_000
  return { time: new Date(t).toISOString(), cpu: 20, mem: 57 }
})

const paths = (c: HTMLElement) => [...c.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '')
const xs = (d: string) => [...d.matchAll(/[ML]\s*(-?[\d.]+)/g)].map((m) => Number(m[1]))

describe('the resource chart does not paint over its own axis', () => {
  it('has samples that fall left of the plot — the premise, measured', () => {
    // Without this the test below could pass on a chart that simply has nothing to clip.
    const before = series.filter((d) => Date.parse(d.time) < AT - 3_600_000)
    expect(before.length, 'no sample precedes the window — raise `RELAY_LAG_MS`').toBeGreaterThan(0)
  })

  it('draws the series inside a clip that starts at the axis', () => {
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )

    const clipped = container.querySelector('g[clip-path]')
    expect(clipped, 'the series is not clipped').not.toBeNull()
    expect(clipped!.querySelectorAll('path').length, 'the area and the line are both inside the clip').toBe(2)

    const rect = container.querySelector('clipPath rect')!
    expect(rect.getAttribute('x'), 'the clip must start at the axis, not left of it').toBe('0')
    expect(Number(rect.getAttribute('width'))).toBeGreaterThan(0)
  })

  it('and the geometry it clips really does reach past the axis', () => {
    // The other half: if the scale ever started clamping, the clip would be inert and this file would go on
    // reporting success for a fix that no longer does anything.
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="mem" hex="#a78bfa" range="1h" now={AT} label="RAM %" />,
    )
    const drawn = paths(container).flatMap(xs)
    expect(drawn.length, 'no path geometry was rendered').toBeGreaterThan(0)
    expect(Math.min(...drawn), 'nothing extends past the axis — the clip is guarding nothing').toBeLessThan(0)
  })
})

describe('the chart does not draw time that has not arrived', () => {
  // `ceil(now / step) * step` ended the window at the *next* round tick, which left up to a full step of
  // axis in the future — an hour of empty 6h chart, ten hours of empty 7d. No sample can ever land there,
  // so the band read as missing data rather than as the edge of the window.
  //
  // Measured on the geometry, not the labels: the newest sample is at `now`, so it belongs at the plot's
  // right edge, and under the old window it stopped short of it by the size of the gap.
  const INSET = 16
  const RIGHT_EDGE = 600 - 40 - 24 - INSET // width - MARGIN.left - MARGIN.right - INSET
  const STEP: Record<string, number> = { '1h': 600_000, '6h': 3_600_000, '24h': 10_800_000, '7d': 86_400_000 }

  // Off every step boundary. On one, `ceil` and `floor` agree and the defect hides.
  const NOW = Date.parse('2026-08-18T02:55:00.000Z') + 61_000

  /** Where a moment in the window lands on the axis — the mapping `scaleTime` is handed. */
  const xOf = (t: number, span: number) => INSET + ((t - (NOW - span)) / span) * (RIGHT_EDGE - INSET)
  const tickXs = (c: HTMLElement) =>
    [...c.querySelectorAll('.visx-axis-bottom text')].map((t) => Number(t.getAttribute('x')))

  it.each([
    ['1h', 3_600_000],
    ['6h', 21_600_000],
    ['24h', 86_400_000],
    ['7d', 604_800_000],
  ] as const)('reaches the right edge with the newest sample on %s', (range, span) => {
    const data = Array.from({ length: 12 }, (_, i) => ({
      time: new Date(NOW - (11 - i) * (span / 11)).toISOString(),
      cpu: 20,
      mem: 57,
    }))
    const { container } = render(
      <AreaChartInner width={600} height={220} data={data} dataKey="cpu" hex="#60a5fa" range={range} now={NOW} label="CPU %" />,
    )
    const drawn = paths(container).flatMap(xs)
    expect(drawn.length, 'no path geometry was rendered').toBeGreaterThan(0)
    expect(Math.max(...drawn), 'the newest sample stops short of the edge — the window runs past `now`')
      .toBeCloseTo(RIGHT_EDGE, 3)

    // **The tick arithmetic itself, which the label assertions cannot reach.** Every candidate tick is a
    // round step, so `tickCount ± 1` changes no label's shape and no format check can see it — measured,
    // `+ 2` and one fewer each left all 34 tests green. One tick too many puts the first label at
    // x = -34 with `text-anchor: start`, painted across the y-axis labels: the defect the first block of
    // this file exists to prevent, arriving through the axis instead of through the series.
    const tickX = tickXs(container)
    expect(tickX.length, 'a tick was invented or dropped').toBe(span / STEP[range])
    expect(Math.min(...tickX), 'a tick fell left of the plot').toBeGreaterThanOrEqual(INSET)
    expect(Math.max(...tickX), 'a tick fell right of the plot').toBeLessThanOrEqual(RIGHT_EDGE)
    expect(tickX[tickX.length - 1], 'the newest tick is not the last round step at or before `now`')
      .toBeCloseTo(xOf(Math.floor(NOW / STEP[range]) * STEP[range], span), 3)
  })

  it('still spaces the ticks a whole step apart, which is what the round-up was for', () => {
    // The other half. Ending the window at `now` must not drag the ticks off the clean step with it —
    // dropping the round-up and letting the ticks fall where the window ends would trade this defect for
    // an axis reading 14:03, 14:13, 14:23.
    //
    // **Measured on the geometry, not on the digits.** `lastTick` is round in UTC and `formatTick` renders
    // local hours, so clean labels hold only where the offset is a whole multiple of the step. Asserting
    // the digits made this file red on an unmodified checkout in Asia/Kathmandu and Pacific/Chatham — a
    // 45-minute zone reads 07:45, 07:55 — with nothing to say the cause was the machine's clock rather
    // than the code. Even spacing and a round anchor are the same claim about the code and no claim at
    // all about the reader's timezone.
    const data = Array.from({ length: 12 }, (_, i) => ({
      time: new Date(NOW - (11 - i) * (3_600_000 / 11)).toISOString(),
      cpu: 20,
      mem: 57,
    }))
    const { container } = render(
      <AreaChartInner width={600} height={220} data={data} dataKey="cpu" hex="#60a5fa" range="1h" now={NOW} label="CPU %" />,
    )
    const tickX = tickXs(container)
    expect(tickX.length, 'no time labels were rendered').toBeGreaterThan(1)
    // One step of window, in pixels. Every gap is this, so no tick sits at an arbitrary offset.
    const perStep = (STEP['1h'] / 3_600_000) * (RIGHT_EDGE - INSET)
    for (const [i, x] of tickX.slice(1).entries()) {
      expect(x - tickX[i], 'the ticks are no longer a whole step apart').toBeCloseTo(perStep, 3)
    }
    expect(tickX[tickX.length - 1], 'the ticks are evenly spaced but off the round step')
      .toBeCloseTo(xOf(Math.floor(NOW / STEP['1h']) * STEP['1h'], 3_600_000), 3)
  })
})

describe('the chart can be read without a mouse', () => {
  // The tooltip is the only place a reading is written down, and it opened on `mousemove` alone — so the
  // page was unreadable to a keyboard user, which is what the a11y gate blocked this change on. Held here
  // rather than left to the gate: the gate reads a diff, and nothing would fail once the file stops changing.
  const setup = () =>
    render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
  const surfaceOf = (c: HTMLElement) => c.querySelector('rect[role="slider"]')!

  it('exposes the cursor as a slider, which is the role whose key model is the arrow keys', () => {
    // **Not `img` or `application`.** A non-widget role leaves NVDA and JAWS in browse mode, where the
    // virtual cursor takes the arrow keys before `onKeyDown` ever runs — the keyboard path would exist and
    // be unreachable for the users it was built for. The reading rides on `aria-valuetext`, so there is no
    // live region to keep in step with it.
    const { container } = setup()
    const surface = surfaceOf(container)
    expect(surface.getAttribute('tabindex')).toBe('0')
    expect(surface.getAttribute('aria-valuemax')).toBe(String(series.length - 1))
    expect(surface.getAttribute('aria-valuetext')).toMatch(/CPU %/)
  })

  it('the arrows walk the series and Escape dismisses the reading', () => {
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    const atFocus = surface.getAttribute('aria-valuenow')
    expect(surface.getAttribute('aria-valuetext')).toMatch(/\d+%/)

    fireEvent.keyDown(surface, { key: 'ArrowLeft' })
    expect(surface.getAttribute('aria-valuenow'), 'ArrowLeft did not move the cursor').not.toBe(atFocus)

    fireEvent.keyDown(surface, { key: 'Home' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')

    // Dismissible without moving focus (WCAG 1.4.13) — the reading overlays the plot.
    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(container.querySelector('[class*="pointer-events-none"]'), 'Escape left the reading up').toBeNull()
  })

  it('names itself with the title the card shows', () => {
    // The page passes its visible card title (`CPU %`), not the legend key (`CPU`) — asserting the latter
    // would check a string the page never produces and would miss the name drifting from what is on screen.
    const { container } = setup()
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toMatch(/^CPU %, last 1h/)
    expect(surfaceOf(container).getAttribute('aria-label')).toBe('CPU % samples')
  })

  it('keeps the cursor where the reader left it when the overlay is dismissed', () => {
    // Derived from `tooltipData`, every path that hid the reading — Escape, blur — snapped the announced
    // value back to the last sample: a change nobody made, and the next arrow key resumed from the end.
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')
    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(surface.getAttribute('aria-valuenow'), 'Escape moved the cursor').toBe('0')
    fireEvent.blur(surface)
    expect(surface.getAttribute('aria-valuenow'), 'blur moved the cursor').toBe('0')
  })

  it('answers the vertical arrows too, which are half of the slider key set', () => {
    const { container } = setup()
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })
    fireEvent.keyDown(surface, { key: 'ArrowUp' })
    expect(surface.getAttribute('aria-valuenow'), 'ArrowUp did not move the cursor').toBe('1')
    fireEvent.keyDown(surface, { key: 'ArrowDown' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')
  })

  it('keeps the announced value inside the series when the range shrinks under it', () => {
    // Switching 7d → 1h leaves a cursor that was valid pointing past the end. Unclamped, `aria-valuenow`
    // sat above `aria-valuemax` with no `aria-valuetext` at all — a slider announcing an index.
    const { container, rerender } = setup()
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'End' })
    expect(surface.getAttribute('aria-valuenow')).toBe(String(series.length - 1))

    rerender(
      <AreaChartInner width={600} height={220} data={series.slice(0, 3)} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
    const after = surfaceOf(container)
    expect(Number(after.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(after.getAttribute('aria-valuemax')))
    expect(after.getAttribute('aria-valuetext'), 'the reading went missing').toMatch(/CPU %/)
  })

  it('returns focus to where the reader left the cursor, not to the end', () => {
    // Focus used to select the newest sample every time, so Escape (or tabbing away) and coming back moved
    // the reader to the other end of the series without a keypress — and the next arrow stepped from there.
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    expect(surface.getAttribute('aria-valuenow'), 'the first focus should open at the newest sample')
      .toBe(String(series.length - 1))
    fireEvent.keyDown(surface, { key: 'Home' })
    fireEvent.keyDown(surface, { key: 'ArrowRight' })
    expect(surface.getAttribute('aria-valuenow')).toBe('1')

    fireEvent.blur(surface)
    fireEvent.focus(surface)
    expect(surface.getAttribute('aria-valuenow'), 'refocus jumped the reader to the end').toBe('1')
  })

  it('tells adjacent samples apart on every range', () => {
    // `formatTick` is the axis format: on 7d it is the date alone, so every sample in a day announced
    // identically and arrowing between neighbours sounded like nothing had moved. The visible tooltip is
    // `aria-hidden`, so this string is the only reading AT gets.
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="7d" now={AT} label="CPU %" />,
    )
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    const first = surface.getAttribute('aria-valuetext')
    fireEvent.keyDown(surface, { key: 'ArrowLeft' })
    expect(surface.getAttribute('aria-valuetext'), 'two samples announce the same thing').not.toBe(first)
  })

  it('announces exactly what it draws', () => {
    // The tooltip is `aria-hidden`, so `aria-valuetext` is the only reading AT gets — and the two used to
    // be formatted separately, diverging first on the date and then on precision (57.4% drawn, "57%"
    // announced). One formatter, asserted against a fractional value so a rounding difference would show.
    const fractional = [{ time: series[0]!.time, cpu: 57.4, mem: 57.4 }, { time: series[1]!.time, cpu: 12.3, mem: 12.3 }]
    const { container } = render(
      <AreaChartInner width={600} height={220} data={fractional} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })

    const announced = surface.getAttribute('aria-valuetext') ?? ''
    expect(announced).toContain('57.4%')
    const drawn = container.querySelector('[aria-hidden="true"]')?.textContent ?? ''
    expect(drawn, 'the drawn reading disagrees with the announced one').toContain('57.4%')

    // The third rendering of the same number: the chart's own summary name, which a reader hears on the
    // way in. It rounded to an integer while both of the above kept a digit.
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('12.3%')
  })

  it('does not paint an outline until focus asks for one', () => {
    // `outline-none` is a *transparent* 2px outline, so colouring it inline drew a black box around every
    // plot at rest — reported from a screenshot, not by any gate.
    const surface = surfaceOf(setup().container)
    expect(surface.getAttribute('style') ?? '', 'an inline outline colour is visible at rest').not.toMatch(/outline/i)
    expect(surface.getAttribute('class') ?? '').toMatch(/focus-visible:outline/)
  })
})
