/**
 * Bottom run strip — a heartbeat-style timeline. Each run is a chip
 * positioned by `created_date` along a horizontal baseline (oldest left,
 * newest right). Click = select active; shift-click = overlay/add.
 *
 * Modelled after `components/hooks/EventSnifferChip`'s HeartbeatChart:
 * baseline + absolutely-positioned event markers. We extend the markers
 * with a verdict-colored border + a time label.
 *
 * Pure render. Cost / step counts / verdict live in the chip tooltip.
 */

import type { AgenticProcess } from '@sdk';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { RunViewModel } from '../data/types';
import { RunChip } from './RunChip';

interface RunStripProps {
  /** All runs (newest-first). */
  runs: AgenticProcess[];
  /** Active + overlay selection (first id = active). */
  selectedIds: string[];
  /** Already-loaded RunViewModels keyed by processId (for verdict/cost). */
  loadedRuns: RunViewModel[];
  onSelectActive: (id: string) => void;
  onToggleOverlay: (id: string) => void;
}

function rawVerdictGuess(p: AgenticProcess): RunViewModel['verdict'] {
  const status = String(p.status ?? '').toLowerCase();
  if (status === 'failed' || status === 'error') return 'fail';
  if (status === 'stopped' || status === 'completed') return 'unknown';
  return 'unknown';
}

function startedAtMs(p: AgenticProcess): number | null {
  const v = p.created_date;
  if (!v) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function chipModel(p: AgenticProcess, loaded?: RunViewModel): RunViewModel {
  if (loaded) return loaded;
  return {
    processId: p.id,
    colorIndex: 0,
    label: '',
    rawStatus: (p.status as string | undefined) ?? undefined,
    verdict: rawVerdictGuess(p),
    startedAt:
      p.created_date instanceof Date
        ? p.created_date.toISOString()
        : (p.created_date as string | undefined),
    durationSec: undefined,
    costUsd: p.total_cost_usd ?? undefined,
    steps: [],
    summary: {
      cleanCount: 0,
      warnCount: 0,
      errorCount: 0,
      pendingCount: 0,
      totalDurationMs: 0,
      total: 0,
    },
    hasTrace: false,
    hasAnalysis: false,
  };
}

function fmtAxisTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtAxisDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const CHIP_WIDTH = 64;

export function RunStrip({
  runs,
  selectedIds,
  loadedRuns,
  onSelectActive,
  onToggleOverlay,
}: RunStripProps) {
  const activeId = selectedIds[0] ?? null;
  const overlay = useMemo(() => new Set(selectedIds.slice(1)), [selectedIds]);
  const loadedById = useMemo(
    () => new Map(loadedRuns.map((r) => [r.processId, r] as const)),
    [loadedRuns],
  );

  const trackRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sort oldest → newest so the timeline reads left-to-right.
  const sorted = useMemo(() => {
    const out = [...runs];
    out.sort((a, b) => (startedAtMs(a) ?? 0) - (startedAtMs(b) ?? 0));
    return out;
  }, [runs]);

  const { tMin, tMax, span } = useMemo(() => {
    const stamps = sorted.map(startedAtMs).filter((v): v is number => v !== null);
    if (stamps.length === 0) return { tMin: 0, tMax: 0, span: 0 };
    const lo = Math.min(...stamps);
    const hi = Math.max(...stamps);
    return { tMin: lo, tMax: hi, span: Math.max(1, hi - lo) };
  }, [sorted]);

  const positions = useMemo(() => {
    if (width === 0 || sorted.length === 0) return [] as { p: AgenticProcess; x: number }[];
    // Inset by half a chip so first/last fit fully inside the track.
    const inset = CHIP_WIDTH / 2;
    const usable = Math.max(0, width - CHIP_WIDTH);
    return sorted.map((p) => {
      const t = startedAtMs(p);
      if (t === null || sorted.length === 1 || span === 0) {
        return { p, x: width / 2 - CHIP_WIDTH / 2 };
      }
      const frac = (t - tMin) / span;
      return { p, x: inset + frac * usable - CHIP_WIDTH / 2 };
    });
  }, [sorted, width, tMin, span]);

  const sameDay = useMemo(() => {
    if (tMin === 0 || tMax === 0) return true;
    const a = new Date(tMin);
    const b = new Date(tMax);
    return a.toDateString() === b.toDateString();
  }, [tMin, tMax]);

  return (
    <div
      data-testid="run-strip"
      className="flex items-stretch gap-3 border-t bg-background px-3 py-2"
    >
      <span className="mt-0.5 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
        Runs ({runs.length})
      </span>
      <div ref={trackRef} className="relative h-12 min-w-0 flex-1">
        {/* baseline */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {/* axis labels */}
        {sorted.length >= 2 && (
          <>
            <span className="absolute -bottom-0.5 left-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">
              {sameDay ? fmtAxisTime(tMin) : fmtAxisDate(tMin)}
            </span>
            <span className="absolute -bottom-0.5 right-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">
              {sameDay ? fmtAxisTime(tMax) : fmtAxisDate(tMax)}
            </span>
          </>
        )}
        {positions.map(({ p, x }) => {
          const isActive = p.id === activeId;
          const isOverlay = overlay.has(p.id);
          const m = chipModel(p, loadedById.get(p.id));
          return (
            <div
              key={p.id}
              className="absolute top-1/2 -translate-y-1/2"
              style={{ left: Math.max(0, x), width: CHIP_WIDTH }}
            >
              <RunChip
                run={m}
                isActive={isActive}
                isOverlay={isOverlay}
                onSelect={(e) => {
                  if (e.shiftKey) onToggleOverlay(p.id);
                  else onSelectActive(p.id);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

