import { useCallback, useEffect, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { Monitor } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { scaleTime, scaleLinear } from '@visx/scale'
import { AreaClosed, LinePath, Bar, Line } from '@visx/shape'
import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { LinearGradient } from '@visx/gradient'
import { Group } from '@visx/group'
import { ParentSize } from '@visx/responsive'
import { useTooltip } from '@visx/tooltip'
import { localPoint } from '@visx/event'
import { curveMonotoneX } from '@visx/curve'
import { bisector } from 'd3-array'
import type { BrowserInbound, SessionInfo } from '@/lib/types'

interface ResourcePoint {
  cpu_percent: number
  mem_percent: number
  recorded_at: string
}

type Range = '1h' | '6h' | '24h' | '7d'

type ChartConfig = Record<string, { label: string; color: string }>

const chartConfig = {
  cpu: { label: 'CPU', color: '#60a5fa' },
  mem: { label: 'RAM', color: '#a78bfa' },
} satisfies ChartConfig

const RANGE_LABELS: Record<Range, string> = { '1h': '1h', '6h': '6h', '24h': '24h', '7d': '7d' }
const RANGE_MS: Record<Range, number> = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000 }
// Clean tick spacing per range (1h→10m, 6h→1h, 24h→3h, 7d→1d).
const TICK_STEP_MS: Record<Range, number> = { '1h': 600_000, '6h': 3_600_000, '24h': 10_800_000, '7d': 86_400_000 }

function formatTick(iso: string, range: Range): string {
  const d = new Date(iso)
  if (range === '7d') return `${d.getMonth() + 1}/${d.getDate()}`
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function MacResources() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [knownAgents, setKnownAgents] = useState<string[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [range, setRange] = useState<Range>('24h')
  const [points, setPoints] = useState<ResourcePoint[]>([])
  const [fetchedAt, setFetchedAt] = useState(() => Date.now())
  const [loading, setLoading] = useState(false)

  const { setNode: setBreadcrumb } = useBreadcrumb()
  useEffect(() => {
    setBreadcrumb(<span className="text-sm font-medium">Mac Resources</span>)
    return () => setBreadcrumb(null)
  }, [setBreadcrumb])

  const handleMessage = useCallback((msg: BrowserInbound) => {
    if (msg.type === 'agents:listed') setSessions(msg.sessions ?? [])
  }, [])
  const { send, connected } = useRelay(handleMessage)

  useEffect(() => {
    if (!connected) return
    send({ type: 'agents:list' })
    const id = setInterval(() => send({ type: 'agents:list' }), 10_000)
    return () => clearInterval(id)
  }, [connected, send])

  useEffect(() => {
    fetch('/api/v1/agents', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setKnownAgents)
  }, [])

  const connectedNames = sessions.map((s) => s.agentName).filter(Boolean) as string[]
  const allAgents = [...new Set([...connectedNames, ...knownAgents])]
  const connectedSet = new Set(connectedNames)

  useEffect(() => {
    if (!selectedAgent && allAgents.length > 0) setSelectedAgent(allAgents[0])
  }, [allAgents.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedAgent) return
    setLoading(true)
    fetch(`/api/v1/agents/${encodeURIComponent(selectedAgent)}/resources?range=${range}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        setPoints(data)
        setFetchedAt(Date.now())
      })
      .finally(() => setLoading(false))
  }, [selectedAgent, range])

  const chartData = points.map((p) => ({
    time: p.recorded_at,
    cpu: Math.round(p.cpu_percent * 10) / 10,
    mem: Math.round(p.mem_percent * 10) / 10,
  }))

  return (
    <div className="flex h-full min-h-0">
      <h1 className="sr-only">Mac Resources</h1>
      {/* Macs sidebar. The title is a heading rather than a styled span for the same reason the chart
          titles are: with the charts now landmarked by `h2`, this list would be the one region of the page
          a screen-reader user could not jump to. */}
      <aside aria-labelledby="macs-heading" className="w-64 shrink-0 border-r flex flex-col gap-1 p-3 overflow-y-auto">
        <h2 id="macs-heading" className="px-2 pb-1 font-mono text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Macs
        </h2>
        {allAgents.length === 0 ? (
          <span className="px-2 text-sm text-muted-foreground">
            {connected ? 'No agents yet.' : 'Connecting…'}
          </span>
        ) : (
          allAgents.map((name) => {
            const isOnline = connectedSet.has(name)
            const isSelected = selectedAgent === name
            return (
              <button
                key={name}
                onClick={() => setSelectedAgent(name)}
                aria-current={isSelected ? 'true' : undefined}
                className={[
                  'flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent transition-colors',
                  isSelected ? 'bg-accent font-medium' : '',
                ].join(' ')}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    isOnline ? 'bg-emerald-400' : 'bg-muted-foreground/40'
                  }`}
                  aria-hidden="true"
                />
                <span className="truncate min-w-0">{name}</span>
                <span className="sr-only">{isOnline ? 'Online' : 'Offline'}</span>
              </button>
            )
          })
        )}
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 overflow-auto">
        {!selectedAgent ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
            <Monitor className="h-8 w-8" />
            <p className="text-sm">Select a Mac to view resource history.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-6 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{selectedAgent}</h2>
              <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
                <TabsList>
                  {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
                    <TabsTrigger key={r} value={r}>{RANGE_LABELS[r]}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            {loading ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading…</div>
            ) : chartData.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                No data yet for this range. Data is collected every minute while the agent is connected.
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <ChartCard title="CPU %" color="cpu" data={chartData} dataKey="cpu" range={range} now={fetchedAt} />
                <ChartCard title="RAM %" color="mem" data={chartData} dataKey="mem" range={range} now={fetchedAt} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

type Datum = { time: string; cpu: number; mem: number }

const getTime = (d: Datum) => new Date(d.time).getTime()

/** The sample, in words. **One function, called by the tooltip and by `aria-valuetext`.** They used to
 *  format separately and diverged twice — a date the axis format had already truncated, then a rounding
 *  that gave the screen-reader user one digit less than the sighted one from the same cursor. The comment
 *  claiming the two agreed was the thing that was false.
 *
 *  `undefined` locale, not `'ko-KR'`: the document is `lang="en"`, an English synthesizer is handed this
 *  string, and every other date in the dashboard already follows the reader's own locale. */
const stampOf = (d: Datum) =>
  new Date(d.time).toLocaleString(undefined, {
    // `hourCycle`, not `hour12: false`: en-US maps that flag to h24, which speaks midnight as "24:00" —
    // an hour that is on no axis in this page. h23 is the cycle the axis labels use.
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
const percentOf = (v: number) => `${Math.round(v * 10) / 10}%`
const bisectTime = bisector<Datum, number>(getTime).left

const MARGIN = { top: 8, right: 24, bottom: 24, left: 40 }
const INSET = 16 // left/right breathing room inside the plot area

function ChartCard({
  title,
  color,
  data,
  dataKey,
  range,
  now,
}: {
  title: string
  color: keyof typeof chartConfig
  data: Datum[]
  dataKey: 'cpu' | 'mem'
  range: Range
  now: number
}) {
  const hex = chartConfig[color].color

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: hex }} />
        {/* A heading, not a styled span: it is a section title in every respect, and it is what names the
            chart below it — an outline of one `h1` and nothing else gives a screen-reader user no way to
            move between the two charts. */}
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <div className="relative h-[220px] w-full">
        <ParentSize>
          {({ width, height }) =>
            width > 0 && height > 0 ? (
              <AreaChartInner width={width} height={height} data={data} dataKey={dataKey} hex={hex} range={range} now={now} label={title} />
            ) : null
          }
        </ParentSize>
      </div>
    </div>
  )
}

/** Exported for `MacResources.chart.test.tsx` only. `ParentSize` measures 0 in jsdom, so the chart never
 *  renders through the page — and the clip below is the kind of thing that regresses silently. */
export function AreaChartInner({
  width,
  height,
  data,
  dataKey,
  hex,
  range,
  now,
  label,
}: {
  width: number
  height: number
  data: Datum[]
  dataKey: 'cpu' | 'mem'
  hex: string
  range: Range
  now: number
  label: string
}) {
  const { showTooltip, hideTooltip, tooltipData, tooltipLeft, tooltipTop } = useTooltip<Datum>()
  const hintId = `chart-hint-${dataKey}`
  // **Its own state, not a view of `tooltipData`.** Derived, every path that hides the reading — Escape,
  // blur — snapped the announced value back to the last sample: a change the user never made, and the next
  // arrow key resumed from the end rather than where they were reading.
  // `null` until the reader places it, which is not the same as 0: an unplaced cursor should open at the
  // newest sample, and a placed one should still be there after Escape or a blur. Focus used to jump to
  // the end unconditionally, so leaving and returning silently moved the reader to the other end of the
  // series and the next arrow key stepped from there.
  const [cursor, setCursor] = useState<number | null>(null)
  // Clamped on render: switching 7d → 1h shrinks `data` under a cursor that was valid, which left
  // `aria-valuenow` above `aria-valuemax` and `aria-valuetext` undefined — a slider announcing a bare
  // out-of-range index instead of a reading.
  const last = Math.max(0, data.length - 1)
  const idx = cursor === null ? last : Math.min(cursor, last)

  const innerW = width - MARGIN.left - MARGIN.right
  const innerH = height - MARGIN.top - MARGIN.bottom

  // **The window ends at `now`, and the ticks are what get rounded — not the window.** Rounding the edge
  // up to the next clean step (`ceil(now / step) * step`) kept the tick times round at the cost of up to a
  // full step of axis that no sample can ever reach: an hour of empty 6h chart, and 63px of 504 on 7d.
  // Empty because it has not happened yet, which reads as a gap in the data rather than as the edge.
  const step = TICK_STEP_MS[range]
  const maxT = now
  const minT = maxT - RANGE_MS[range]
  const xScale = scaleTime({ domain: [minT, maxT], range: [INSET, Math.max(INSET, innerW - INSET)] })
  const yScale = scaleLinear({ domain: [0, 100], range: [innerH, INSET] })
  // Counted down from the last round step at or before `now`, so the ticks stay on clean times without
  // the window following them into the future. Ticks span the whole window regardless of where data
  // exists. **Round in UTC**, which `formatTick` then renders locally — so the labels read 23:50 only
  // where the offset is a whole multiple of the step, and 07:45 in a 45-minute zone.
  const lastTick = Math.floor(maxT / step) * step
  const tickCount = Math.floor((lastTick - minT) / step) + 1
  const ticks = Array.from({ length: tickCount }, (_, i) => new Date(lastTick - (tickCount - 1 - i) * step))

  const gradId = `fill-${dataKey}`
  const clipId = `plot-${dataKey}`

  /** Show the sample at `i`, the way a pointer move would. The keyboard path lands here too. */
  const showAt = (i: number) => {
    const d = data[i]
    if (!d) return
    setCursor(i)
    showTooltip({ tooltipData: d, tooltipLeft: xScale(getTime(d)), tooltipTop: yScale(d[dataKey]) })
  }

  // **The values in this chart were mouse-only.** The tooltip is the only place a reading is written down,
  // and it opened on `mousemove` alone — so a keyboard user could reach the page and read nothing from it.
  // Arrow keys walk the samples, Home/End jump to the ends, and the focused reading is announced through
  // the live region below rather than inferred from a tooltip nobody can see.
  const handleKey = (e: React.KeyboardEvent<SVGRectElement>) => {
    if (data.length === 0) return
    // Dismissible without moving focus (WCAG 1.4.13): the reading overlays the plot, and a magnifier user
    // whose view it covers should not have to tab away to clear it.
    if (e.key === 'Escape') { hideTooltip(); return }
    // Vertical arrows too: they are half of the slider pattern's key set, and a screen-reader user in
    // focus mode reaches for them as readily as the horizontal pair.
    const current = idx
    const next =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? Math.max(0, current - 1)
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? Math.min(data.length - 1, current + 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? data.length - 1
      : null
    if (next === null) return
    e.preventDefault()
    showAt(next)
  }

  const handleMove = (e: React.MouseEvent<SVGRectElement> | React.TouchEvent<SVGRectElement>) => {
    const point = localPoint(e)
    if (!point) return
    const t0 = xScale.invert(point.x - MARGIN.left).getTime()
    const i = bisectTime(data, t0)
    const lo = data[i - 1]
    const hi = data[i]
    const d = lo && hi ? (t0 - getTime(lo) < getTime(hi) - t0 ? lo : hi) : (lo ?? hi)
    if (!d) return
    // Through `showAt`, so the cursor is the one source of position. Calling `showTooltip` directly here
    // moved what is drawn while `aria-valuenow` kept reporting the keyboard's index — the slider's state
    // then described something other than what it was showing.
    showAt(data.indexOf(d))
  }

  const latest = data[data.length - 1]
  // Named, because the page renders two of these side by side — an unattributed "02:50, 57%" does not say
  // which chart answered. The rest comes from `stampOf`/`percentOf`, which the visible tooltip also calls:
  // this is the only reading AT gets, since that tooltip is `aria-hidden`, so the two must not drift.
  const reading = (d: Datum) => `${label}, ${stampOf(d)}, ${percentOf(d[dataKey])}`

  return (
    <>
      {/* `group`, not `img`: `img` takes presentational children, and the focusable surface below lives
          inside this subtree — under `img` the one element the keyboard path depends on is in a subtree
          AT is told not to expose, so the support would exist and never be advertised. */}
      <svg
        width={width}
        height={height}
        role="group"
        aria-label={
          latest
            ? `${label}, last ${range}. Latest ${percentOf(latest[dataKey])}.`
            : `${label}, last ${range}. No samples.`
        }
      >
        <LinearGradient id={gradId} from={hex} to={hex} fromOpacity={0.3} toOpacity={0} fromOffset="5%" toOffset="95%" />
        {/* **The series is clipped to the plot, and the axis labels live outside it.** The window runs
            `now - interval` to `now` on the dashboard's clock, while the relay selects the samples from
            *its own* — two clocks only ever approximately equal, so a relay running behind returns points
            older than the window's left edge. `scaleTime` does not clamp, so those points map to a
            negative x and the area painted straight through the y-axis labels, worst on a series sitting
            where the labels are (RAM at ~57% covers 50% and 25%).
            Clipping rather than dropping them: a point just off-window still shapes the curve at the edge,
            which is what an off-screen sample should do. */}
        <clipPath id={clipId}>
          <rect x={0} y={0} width={Math.max(0, innerW)} height={Math.max(0, innerH)} />
        </clipPath>
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows scale={yScale} width={innerW} tickValues={[0, 25, 50, 75, 100]} strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <g clipPath={`url(#${clipId})`}>
            <AreaClosed<Datum>
              data={data}
              x={(d) => xScale(getTime(d))}
              y={(d) => yScale(d[dataKey])}
              yScale={yScale}
              curve={curveMonotoneX}
              fill={`url(#${gradId})`}
            />
            <LinePath<Datum>
              data={data}
              x={(d) => xScale(getTime(d))}
              y={(d) => yScale(d[dataKey])}
              curve={curveMonotoneX}
              stroke={hex}
              strokeWidth={1.5}
            />
          </g>
          <AxisBottom
            top={innerH}
            scale={xScale}
            tickValues={ticks}
            tickFormat={(v) => formatTick(new Date(+v).toISOString(), range)}
            hideAxisLine
            hideTicks
            tickLength={0}
            tickLabelProps={(_v, index, all) => ({
              fontSize: 11,
              fill: 'currentColor',
              textAnchor: index === 0 ? 'start' : index === all.length - 1 ? 'end' : 'middle',
              dy: 6,
              className: 'fill-muted-foreground',
            })}
          />
          <AxisLeft
            scale={yScale}
            tickValues={[0, 25, 50, 75, 100]}
            tickFormat={(v) => `${v}%`}
            hideAxisLine
            hideTicks
            tickLabelProps={() => ({ fontSize: 11, fill: 'currentColor', textAnchor: 'end', dx: -4, dy: 3, className: 'fill-muted-foreground' })}
          />
          {tooltipData && (
            <g style={{ transition: 'transform 0.25s ease-out', transform: `translateX(${tooltipLeft ?? 0}px)` }} pointerEvents="none">
              <Line from={{ x: 0, y: INSET }} to={{ x: 0, y: innerH }} stroke="hsl(var(--border))" strokeWidth={1} />
              <circle cx={0} cy={0} r={3} fill={hex} stroke="hsl(var(--background))" strokeWidth={1.5} style={{ transition: 'transform 0.25s ease-out', transform: `translateY(${tooltipTop ?? 0}px)` }} />
            </g>
          )}
          <Bar
            x={0}
            y={0}
            width={Math.max(0, innerW)}
            height={Math.max(0, innerH)}
            fill="transparent"
            tabIndex={0}
            // **`slider`, over the sample index.** `img` was worse than useless here: a non-widget role
            // leaves NVDA and JAWS in browse mode, where the virtual cursor swallows the arrow keys before
            // `onKeyDown` sees them — the keyboard path would exist for exactly the users who could not
            // reach it. A slider's native key model *is* arrow keys, and `aria-valuetext` speaks the
            // reading on every move, which is why there is no live region here any more.
            role="slider"
            aria-label={`${label} samples`}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, data.length - 1)}
            aria-valuenow={idx}
            aria-valuetext={data[idx] ? reading(data[idx]!) : undefined}
            aria-describedby={hintId}
            // No inline `outlineColor`: `outline-none` is a *transparent* 2px outline, so colouring it
            // here painted a black box around the plot at rest. The colour belongs in the focus variant.
            className="outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onFocus={() => showAt(idx)}
            onBlur={hideTooltip}
            onKeyDown={handleKey}
            onMouseMove={handleMove}
            onMouseLeave={hideTooltip}
            onTouchMove={handleMove}
            onTouchEnd={hideTooltip}
            onTouchCancel={hideTooltip}
          />
        </Group>
      </svg>
      <p id={hintId} className="sr-only">Use the arrow keys to read individual samples. Escape hides the reading.</p>
      {tooltipData && (
        <div
          // The reading rides on `aria-valuetext`; this is the same value drawn, and exposing both gave a
          // browse-mode reader two renderings of it that disagreed on date format and rounding.
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 whitespace-nowrap rounded-lg border bg-background px-3 py-2 text-xs text-foreground shadow-md"
          style={{
            // transform (not left/top) so position eases smoothly like recharts
            transform: `translate(${(tooltipLeft ?? 0) + MARGIN.left}px, ${(tooltipTop ?? 0) + MARGIN.top}px) translate(${(tooltipLeft ?? 0) > innerW * 0.6 ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
            transition: 'transform 0.25s ease-out',
          }}
        >
          <p className="mb-1">
            Date:{' '}
            {stampOf(tooltipData)}
          </p>
          <p>
            {label}: {percentOf(tooltipData[dataKey])}
          </p>
        </div>
      )}
    </>
  )
}
