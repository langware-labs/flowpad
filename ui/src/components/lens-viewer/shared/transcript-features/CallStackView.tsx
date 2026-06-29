import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

import { VerdictBanner, type VerdictBannerData } from '@src/components/assets/editor/agent-trace/AgentTraceView';
import { TraceTimeline, OUTLINE_LEGEND } from '@src/components/assets/editor/agent-trace/TraceTimeline';
import { cn } from '@src/lib/utils';
import {
  peakCostPerHour,
  tsMs,
  type SkillIssue,
  type TraceLane,
} from '@src/components/assets/editor/agent-trace/trace-types';
import { useTraceSkeleton } from '@src/components/assets/editor/agent-trace/useTraceSkeleton';
import type { WorkerType } from '@src/hooks/use-transcript';
import { useSkillsByName } from '@src/hooks/useSkillsByName';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { useTranscriptZoom } from '../use-transcript-zoom';

/** Build the standard `skill_issues` overlay lane from analysis-sourced issues
 * (a saved trace's `annotations.divergences`/`issues`). Each becomes a
 * `skill_issue` event; the lane spans first→last. Returns null when empty. */
function buildSkillIssuesLane(items: SkillIssue[] | undefined): TraceLane | null {
  const events = (items ?? [])
    .map((si) => ({
      ts: si.ts ?? si.start_ts ?? '',
      lane_id: 'skill_issues',
      kind: 'skill_issue' as const,
      label: si.label,
      severity: si.severity ?? 'notable',
      entry_id: '',
    }))
    .filter((e) => e.ts);
  if (!events.length) return null;
  const ts = events.map((e) => e.ts).sort();
  return {
    id: 'skill_issues',
    kind: 'skill_issues',
    depth: 1,
    description: 'skill issues',
    parent_lane_id: 'root',
    start_ts: ts[0],
    end_ts: ts[ts.length - 1],
    segments: [],
    events,
  };
}

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
  skillIssues,
  zoom: zoomProp,
  onZoomChange,
}: {
  workerType: WorkerType;
  sessionId: string | null;
  /** Optional analysis-sourced skill issues (from a saved trace's annotations).
   * When present, rendered as the standard `skill_issues` overlay lane. */
  skillIssues?: SkillIssue[];
  /** Controlled zoom window (ms). When `onZoomChange` is supplied the host owns
   * zoom (e.g. the agent_trace asset editor); otherwise it falls back to the
   * transcript-dock URL zoom. */
  zoom?: [number, number] | null;
  onZoomChange?: (zoom: [number, number] | null) => void;
}) {
  const { skeleton, error, loading } = useTraceSkeleton(workerType, sessionId);
  const { navigation } = useDockNavigation();
  const { byName } = useSkillsByName();
  const advanced = useIsAdvanced();
  // Transcript-dock URL zoom is the default (lens); a host can control zoom via
  // props (the asset editor, whose pointer the transcript zoom hook can't patch).
  const [transcriptZoom, setTranscriptZoom] = useTranscriptZoom();
  const zoom = onZoomChange ? (zoomProp ?? null) : transcriptZoom;
  const setZoom = onZoomChange ?? setTranscriptZoom;
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);

  const doc = skeleton;
  const outline = doc?.outline ?? null;
  // Base outline from the skeleton; the `errors` (agent-errors) lane is an
  // advanced-only detail. Skill issues from the saved analysis (optional input)
  // are overlaid as the standard `skill_issues` lane.
  const displayOutline = useMemo(() => {
    if (!outline) return undefined;
    const base = advanced ? outline : outline.filter((l) => l.kind !== 'errors');
    const issuesLane = buildSkillIssuesLane(skillIssues);
    if (!issuesLane) return base;
    // Place it among the session-level lanes (after root/user/tasks/errors).
    let at = -1;
    base.forEach((l, i) => {
      if (['root', 'user', 'tasks', 'errors'].includes(l.kind)) at = i;
    });
    return [...base.slice(0, at + 1), issuesLane, ...base.slice(at + 1)];
  }, [outline, advanced, skillIssues]);

  const startMs = useMemo(() => {
    if (!doc) return null;
    const stamps = doc.lanes.map((l) => tsMs(l.start_ts)).filter((v): v is number => v !== null);
    return stamps.length ? Math.min(...stamps) : null;
  }, [doc]);
  const maxCostPerHour = useMemo(() => (doc ? peakCostPerHour(doc) : 0), [doc]);

  // Clicking the skill *name* (not the row) opens its asset.
  const handleOpenLane = (id: string) => {
    const lane = outline?.find((l) => l.id === id);
    if (lane?.kind === 'skill' && lane.skill_name) {
      const skill = byName.get(lane.skill_name);
      if (skill) navigation.openDock(skill.editorDockPointer);
    }
  };

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-destructive">
        <Trans>Failed to build call stack: {error}</Trans>
      </div>
    );
  }
  if (loading || !doc) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <Trans>Building call stack…</Trans>
      </div>
    );
  }
  const effectiveCursor = cursorMs ?? startMs;
  if (!outline || outline.length === 0 || effectiveCursor === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Trans>No high-level calls in this session.</Trans>
      </div>
    );
  }

  const bannerData: VerdictBannerData = { ...doc.summary, maxCostPerHour };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-callstack-view">
      {/* Matches Execution's top control-row height so the cost header below it
          lands at the same Y — toggling doesn't shift the layout. The legend
          decodes the timeline markers. */}
      <div className="flex shrink-0 items-center gap-4 border-b border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-medium"><Trans>Session call stack</Trans></span>
        <span className="flex items-center gap-3">
          {OUTLINE_LEGEND.filter(({ advancedOnly, requiresLane }) =>
            (advanced || !advancedOnly) &&
            (!requiresLane || (displayOutline?.some((l) => l.kind === requiresLane) ?? false)),
          ).map(({ color, label }) => (
            <span key={label} className="flex items-center gap-1">
              <span className={cn('h-2 w-2 rotate-45 rounded-[1px]', color)} />
              {label}
            </span>
          ))}
        </span>
      </div>
      <VerdictBanner data={bannerData} />
      <TraceTimeline
        doc={doc}
        displayLanes={displayOutline ?? undefined}
        cursorMs={effectiveCursor}
        onCursorChange={setCursorMs}
        selectedLaneId={selectedLaneId}
        onSelectLane={setSelectedLaneId}
        onOpenLane={handleOpenLane}
        zoom={zoom}
        onZoomChange={setZoom}
      />
    </div>
  );
}
