'use client';

import { useEffect, useMemo, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { performanceMode } from '@/lib/decoders/pickDecoder';
import { PerformanceModeNotice } from '@/components/perf/PerformanceModeNotice';
import { shouldAutoShowPerfNotice, PERF_NOTICE_KEY } from '@/lib/perfNotice';

// init wizard와 같은 프로파일 용어로 — 디코더 jargon(WebCodecs/WASM) 대신.
const MODE_LABEL: Record<string, string | null> = {
  high: 'Smooth',
  standard: 'Standard',
  unsupported: null,
};

interface SimulatorInfoCardProps {
  joined: boolean;
  fps: number;
  connected: boolean;
  deviceReady: boolean;
  bootError: string | null;
  installing: boolean;
  installError: string | null;
  /** H.264 decode path is unavailable in this browser — the viewer can render the device chrome but
   *  no stream (#748). Routed through this shared status region so Android and iOS converge on the
   *  same one-sentence English copy instead of each viewer shipping its own overlay. */
  decoderUnsupported: boolean;
  keyboardActive: boolean;
  /** The relay is holding this session open while its agent is gone (#426). Outranks every other
   *  status: the rest describe a device this viewer cannot currently reach. */
  agentAway?: boolean;
}

function getStatusText(props: SimulatorInfoCardProps): string | null {
  const { connected, joined, bootError, deviceReady, installing, installError, agentAway, decoderUnsupported } = props;
  if (!connected) return 'Connecting…';
  if (!joined) return 'Joining session…';
  if (agentAway) return 'The agent went away — waiting for it to come back…';
  if (bootError)
    return `Boot failed: ${bootError.length > 40 ? bootError.slice(0, 40) + '…' : bootError}`;
  if (!deviceReady) return 'Starting device…';
  if (installing) return 'Installing app…';
  if (installError) return `Install failed: ${installError}`;
  if (decoderUnsupported) return 'Streaming is not supported in this environment.';
  return null;
}

export function SimulatorInfoCard(props: SimulatorInfoCardProps) {
  const { joined, fps, keyboardActive } = props;
  const statusText = getStatusText(props);
  // fps is intentionally low when screen is static (idle keep-alive ~10fps).
  // Use "active/idle" framing instead of red/green to avoid false alarm.
  const isActive = fps > 15;
  // fps 0 (fully static screen / between frames) is still idle, not a blank state — keep the gray
  // dot and "Idle" label instead of hiding them.
  const dotColor = isActive ? '#10b981' : '#94a3b8';
  const stateLabel = isActive ? 'Active' : 'Idle';
  // Decode path is a stable per-browser capability; compute once, not per device card.
  const mode = useMemo(() => performanceMode(), []);
  const modeLabel = MODE_LABEL[mode];
  const [noticeOpen, setNoticeOpen] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(PERF_NOTICE_KEY) === '1';
    } catch {
      /* no storage */
    }
    if (shouldAutoShowPerfNotice(mode, dismissed)) setNoticeOpen(true);
  }, [mode]);
  const handleNoticeOpenChange = (next: boolean) => {
    setNoticeOpen(next);
    if (!next) {
      try {
        localStorage.setItem(PERF_NOTICE_KEY, '1');
      } catch {
        /* no storage */
      }
    }
  };

  return (
    <div className="w-[300px] shrink-0 mt-3 rounded-xl border bg-background px-4 py-4 flex flex-col gap-3">
      <div
        className={cn(
          'flex items-center',
          keyboardActive ? 'text-emerald-500' : 'text-muted-foreground',
        )}
        style={{ gap: 6 }}
      >
        <ScanLine className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[12px] font-medium">Focus</span>
      </div>

      {joined && (
        <div className="flex items-center gap-[12px]">
          <div className="flex items-center gap-[4px]">
            <span className="h-2 w-2 rounded-full shrink-0 mr-1" style={{ background: dotColor }} />
            <span className="text-[12px] font-mono text-foreground/75">{fps}</span>
            <span className="text-[12px] text-muted-foreground">fps</span>
            {stateLabel && <span className="text-[11px] text-muted-foreground/60">·</span>}
            {stateLabel && (
              <span
                className={cn(
                  'text-[11px]',
                  isActive ? 'text-emerald-500' : 'text-muted-foreground/60',
                )}
              >
                {stateLabel}
              </span>
            )}
          </div>
          {modeLabel && (
            <>
              <Separator orientation="vertical" className="h-3" />
              {mode === 'standard' ? (
                <button
                  type="button"
                  onClick={() => setNoticeOpen(true)}
                  className="text-[11px] text-foreground/70 hover:text-foreground underline-offset-2 hover:underline"
                >
                  {modeLabel}
                </button>
              ) : (
                <span className="text-[11px] text-muted-foreground">{modeLabel}</span>
              )}
            </>
          )}
        </div>
      )}

      {/* **The region is always mounted and the sentence arrives inside it**, which is the shape a
          live region has to have. This sentence is the only thing that says what a boot is doing, and
          after #628 a keyboard user is parked beside it for a whole restart.
          `role="status"` on the `<p>` itself does not work: that element is conditional, so the region
          and its first sentence land in the same commit with nothing to compare against — "Starting
          device…" and "Boot failed…" are exactly the transitions that go missing. Mounting the `<p>`
          unconditionally instead adds a line's height to every card with nothing to say, and a second
          sr-only copy of the text puts the same sentence in the tree twice. An empty wrapper costs
          neither. */}
      {/* `sr-only` while empty, which is `position: absolute` — so it stops being a flex item and stops
          consuming one of the parent's `gap-3`. The normal state of this card is *no* sentence at all
          (connected, joined, ready, installed), and that is where a permanently mounted 0-height child
          would still have added 12px. The node is the same one either way, which is the whole point of
          mounting it early. */}
      <div role="status" className={statusText ? undefined : 'sr-only'}>
      {statusText && (
        <p className="text-[12px] text-muted-foreground leading-relaxed break-words">{statusText}</p>
      )}
      </div>

      <PerformanceModeNotice open={noticeOpen} onOpenChange={handleNoticeOpenChange} />
    </div>
  );
}
