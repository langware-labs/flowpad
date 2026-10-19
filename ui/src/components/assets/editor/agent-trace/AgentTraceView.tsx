import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@src/components/ui/tabs';
import { formatDuration } from '@src/components/lens-viewer/shared/format-utils';
import { cn } from '@src/lib/utils';

import { CallTreeView } from './CallTreeView';
import { TraceDetailPanel } from './TraceDetailPanel';
import { TraceTimeline } from './TraceTimeline';
import { peakCostPerHour, tsMs, type AgentTraceDoc, type CallFrame } from './trace-types';
import { useAgentTraceTab } from './use-agent-trace-tab';

export function verdictStyle(verdict?: string | null): string {
  switch (verdict) {
    case 'ok':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'mixed':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'bad':
      return 'bg-red-500/10 text-red-600 dark:text-red-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/** Summary fields the verdict banner renders — satisfied by both the AgentTrace
 * entity row (so the banner can show before the JSON loads) and `doc.summary`. */
export interface VerdictBannerData {
  verdict?: string | null;
  verdict_reason?: string | null;
  issue_count: number;
  divergence_count: number;
  lane_count: number;
  duration_ms?: number | null;
  cost_usd?: number | null;
  /** Peak spend rate ($/h); only available once the trace doc is loaded. */
  maxCostPerHour?: number | null;
}

export function VerdictBanner({ data }: { data: VerdictBannerData }) {
  const { t } = useLingui();
  // A verdict only exists once the session has been analyzed — the raw
  // (skeleton) call stack has none, so we show no rating chip rather than an
  // "unrated" label that reads like a bad grade.
  const hasVerdict = !!data.verdict && data.verdict !== 'unrated';
  return (
    <div
      className={cn('flex flex-shrink-0 items-baseline gap-2 px-3 py-2', verdictStyle(data.verdict))}
      data-testid="agent-trace-verdict-banner"
    >
      <span className="text-sm font-semibold tabular-nums" title={t`Total cost`}>
        {data.cost_usd != null ? `$${data.cost_usd.toFixed(2)}` : '—'}
      </span>
      <span className="text-[11px] uppercase tracking-wide opacity-70">
        <Trans>total</Trans>
      </span>
      {data.maxCostPerHour != null && data.maxCostPerHour > 0 && (
        <>
          <span className="ms-2 text-sm font-semibold tabular-nums" title={t`Peak spend rate`}>
            ${data.maxCostPerHour.toFixed(2)}/h
          </span>
          <span className="text-[11px] uppercase tracking-wide opacity-70">
            <Trans>peak</Trans>
          </span>
        </>
      )}
      {hasVerdict && (
        <span className="ring-current/30 ms-2 rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1">
          {data.verdict}
        </span>
      )}
      {hasVerdict && data.verdict_reason && (
        <span className="min-w-0 flex-1 truncate text-sm">{data.verdict_reason}</span>
      )}
      <span className="ms-auto flex-shrink-0 text-xs opacity-80">
        <Trans>
          {data.issue_count} issues · {data.divergence_count} divergences · {data.lane_count} lanes ·{' '}
          {data.duration_ms ? formatDuration(data.duration_ms) : '—'}
        </Trans>
      </span>
    </div>
  );
}

interface AgentTraceViewProps {
  doc: AgentTraceDoc;
  /** Banner data override (e.g. the entity summary so values match the pre-load
   * banner). Defaults to `doc.summary`. */
  banner?: VerdictBannerData;
  /** Launch a skillit analysis for a skill named in the call stack. Omitted in
   *  the read-only lens variant (no Evaluate button there). */
  onEvaluateSkill?: (skillName: string) => void;
}

/**
 * Presentational AgentTrace body: verdict banner, call-stack / details tabs, and
 * the scrubbing timeline — owns cursor + frame/lane selection. No data loading,
 * no asset header. Shared by the standalone `AgentTraceAssetEditor` and the
 * transcript lens's "Call stack" view.
 */
export function AgentTraceView({ doc, banner, onEvaluateSkill }: AgentTraceViewProps) {
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<CallFrame | null>(null);
  const [tab, setTab] = useAgentTraceTab();

  const startMs = useMemo(() => {
    const stamps = doc.lanes.map((l) => tsMs(l.start_ts)).filter((v): v is number => v !== null);
    return stamps.length ? Math.min(...stamps) : null;
  }, [doc]);
  const effectiveCursor = cursorMs ?? startMs;

  // Headline burn rate, derived from the loaded doc.
  const maxCostPerHour = useMemo(() => peakCostPerHour(doc), [doc]);
  const bannerData: VerdictBannerData = { ...(banner ?? doc.summary), maxCostPerHour };

  // Click a call-tree frame → seek the timeline to it, highlight its lane, and
  // open the Details tab scoped to that frame.
  const handleSelectFrame = (frame: CallFrame) => {
    setSelectedFrame(frame);
    setSelectedLaneId(frame.lane_id);
    const ms = tsMs(frame.start_ts);
    if (ms !== null) setCursorMs(ms);
    setTab('details');
  };

  // Scrubbing the timeline returns to time-based detail (unpins the frame).
  const handleCursorChange = (ms: number) => {
    setCursorMs(ms);
    setSelectedFrame(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <VerdictBanner data={bannerData} />

      {effectiveCursor === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Trans>No timeline data in this trace.</Trans>
        </div>
      ) : (
        <>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as 'stack' | 'details')}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="mx-3 mt-2 h-8 self-start">
              <TabsTrigger value="stack" className="py-0.5 text-xs">
                <Trans>Call tree</Trans>
              </TabsTrigger>
              <TabsTrigger value="details" className="py-0.5 text-xs">
                <Trans>Details</Trans>
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="stack"
              forceMount
              className="mt-1 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            >
              <CallTreeView
                doc={doc}
                selectedFrameId={selectedFrame?.id ?? null}
                onSelectFrame={handleSelectFrame}
                onEvaluateSkill={onEvaluateSkill}
              />
            </TabsContent>
            <TabsContent
              value="details"
              forceMount
              className="mt-1 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            >
              <TraceDetailPanel
                doc={doc}
                cursorMs={effectiveCursor}
                selectedLaneId={selectedLaneId}
                selectedFrame={selectedFrame}
              />
            </TabsContent>
          </Tabs>
          <TraceTimeline
            doc={doc}
            cursorMs={effectiveCursor}
            onCursorChange={handleCursorChange}
            selectedLaneId={selectedLaneId}
            onSelectLane={setSelectedLaneId}
          />
        </>
      )}
    </div>
  );
}
