/**
 * Top-level workflow runner view — the only component WorkflowAssetEditor
 * mounts to surface runs.
 *
 * Phase 2: minimal shell. Wires useRunnerData → AnnotatedDocument. No
 * selection wiring (Phase 3), no run strip (Phase 4), no attention
 * banner (Phase 5), no expert mode toggle (Phase 6).
 *
 * Pure render: data comes from useRunnerData; UI state (selectedLine,
 * viewMode) will be hooked in subsequent phases.
 */

import { AgenticProcess, Workflow } from '@sdk';
import { useMemo } from 'react';

import { useDismissedAttentions } from './data/useDismissedAttentions';
import { useRunnerData } from './data/useRunnerData';
import { useRunSelection } from './data/useRunSelection';
import { useStepSelection } from './data/useStepSelection';
import { useStripRunSummaries } from './data/useStripRunSummaries';
import { useViewMode } from './data/useViewMode';
import { AnnotatedDocument } from './document/AnnotatedDocument';
import { StepDetailPane } from './detail/StepDetailPane';
import { AttentionBanner } from './header/AttentionBanner';
import { RunSummaryStrip } from './header/RunSummaryStrip';
import { AggregateFooter } from './footer/AggregateFooter';
import { MemoryPane } from './learning/MemoryPane';
import { PastAttemptsPane } from './learning/PastAttemptsPane';
import { RunStrip } from './runs/RunStrip';

interface WorkflowRunnerViewProps {
  workflow: Workflow;
  /** Newest-first list of runs (caller sorts). */
  runs: AgenticProcess[];
}

export function WorkflowRunnerView({ workflow, runs }: WorkflowRunnerViewProps) {
  const { selectedLine, selectStep, toggleStep } = useStepSelection();
  const availableIds = useMemo(() => runs.map((r) => r.id), [runs]);
  const { selectedIds, selectRun, toggleOverlay } = useRunSelection(availableIds);
  const { viewMode, setViewMode } = useViewMode();

  const vm = useRunnerData({ workflow, runs, selectedRunIds: selectedIds });
  const stripSummaries = useStripRunSummaries(runs, vm.fullText);
  const { isDismissed, dismiss } = useDismissedAttentions(workflow.id);

  const selectedStep = useMemo(() => {
    if (selectedLine == null) return null;
    const activeRun = vm.runs[0];
    return activeRun?.steps.find((s) => s.line === selectedLine) ?? null;
  }, [vm.runs, selectedLine]);

  const selectedHistory =
    selectedLine != null ? vm.stepHistory.get(selectedLine) : undefined;

  return (
    <div
      data-testid="workflow-runner-view"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <RunSummaryStrip
        workflow={workflow}
        activeRun={vm.runs[0]}
        totalRunCount={runs.length}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />
      <AttentionBanner
        items={vm.attentions}
        isDismissed={isDismissed}
        onDismiss={dismiss}
        onAnchor={(line) => selectStep(line)}
      />
      <MemoryPane memory={vm.learning.memory} />
      <PastAttemptsPane learningLog={vm.learning.learningLog} />
      <div className="grid min-h-0 flex-1 grid-cols-[3fr_2fr] gap-0 overflow-hidden">
        <div className="min-h-0 overflow-hidden border-r">
          <AnnotatedDocument
            source={vm.fullText}
            runs={vm.runs}
            stepHistory={vm.stepHistory}
            selectedLine={selectedLine}
            viewMode={viewMode}
            onSelectStep={toggleStep}
          />
        </div>
        <div className="min-h-0 overflow-hidden">
          <StepDetailPane
            step={selectedStep}
            history={selectedHistory}
            memory={vm.learning.memory}
            viewMode={viewMode}
            onClose={() => selectStep(null)}
          />
        </div>
      </div>
      <RunStrip
        runs={runs}
        selectedIds={selectedIds}
        loadedRuns={vm.runs}
        stripSummaries={stripSummaries}
        onSelectActive={selectRun}
        onToggleOverlay={toggleOverlay}
      />
      <AggregateFooter runs={runs} loadedRuns={vm.runs} />
    </div>
  );
}
