import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { VerdictBanner, type VerdictBannerData } from '@src/components/assets/editor/agent-trace/AgentTraceView';
import { TraceTimeline } from '@src/components/assets/editor/agent-trace/TraceTimeline';
import { peakCostPerHour, tsMs } from '@src/components/assets/editor/agent-trace/trace-types';
import { useTraceSkeleton } from '@src/components/assets/editor/agent-trace/useTraceSkeleton';
import type { WorkerType } from '@src/hooks/use-transcript';
import { useSkillsByName } from '@src/hooks/useSkillsByName';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * "Call stack" view — a high-level, timeline-stacked session view: skills and
 * subagents drawn on the time axis and **nested under their owning skill** (via
 * the authoritative `attribution_skill`), with the un-nestable progress —
 * plan-mode spans and user interrupts — on the root lane. No tool-level "real
 * work".
 *
 * It reuses Execution's chrome on purpose: the same cost header (total · peak)
 * on top and the same cost graphs (time · $/h · Σ$) below, sharing one time
 * axis, so toggling Call stack ↔ Execution doesn't move anything. Deterministic
 * (from the skeleton `outline`), no analysis run required.
 */
export function CallStackView({
  workerType,
  sessionId,
}: {
  workerType: WorkerType;
  sessionId: string | null;
}) {
  const { skeleton, error, loading } = useTraceSkeleton(workerType, sessionId);
  const { navigation } = useDockNavigation();
  const { byName } = useSkillsByName();
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);

  const doc = skeleton;
  const outline = doc?.outline ?? null;

  const startMs = useMemo(() => {
    if (!doc) return null;
    const stamps = doc.lanes.map((l) => tsMs(l.start_ts)).filter((v): v is number => v !== null);
    return stamps.length ? Math.min(...stamps) : null;
  }, [doc]);
  const maxCostPerHour = useMemo(() => (doc ? peakCostPerHour(doc) : 0), [doc]);

  // Clicking a skill lane opens its asset; other lanes just highlight.
  const handleSelectLane = (id: string | null) => {
    const lane = id ? outline?.find((l) => l.id === id) : null;
    if (lane?.kind === 'skill' && lane.skill_name) {
      const skill = byName.get(lane.skill_name);
      if (skill) {
        navigation.openDock(skill.editorDockPointer);
        return;
      }
    }
    setSelectedLaneId(id);
  };

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-destructive">
        Failed to build call stack: {error}
      </div>
    );
  }
  if (loading || !doc) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Building call stack…
      </div>
    );
  }
  const effectiveCursor = cursorMs ?? startMs;
  if (!outline || outline.length === 0 || effectiveCursor === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No high-level calls in this session.
      </div>
    );
  }

  const bannerData: VerdictBannerData = { ...doc.summary, maxCostPerHour };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-callstack-view">
      {/* Matches Execution's top control-row height so the cost header below it
          lands at the same Y — toggling doesn't shift the layout. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        Session call stack — skills · subagents · plan &amp; interrupts on the timeline
      </div>
      <VerdictBanner data={bannerData} />
      <TraceTimeline
        doc={doc}
        displayLanes={outline}
        cursorMs={effectiveCursor}
        onCursorChange={setCursorMs}
        selectedLaneId={selectedLaneId}
        onSelectLane={handleSelectLane}
      />
    </div>
  );
}
