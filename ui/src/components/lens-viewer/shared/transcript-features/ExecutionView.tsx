import { Loader2 } from 'lucide-react';

import { AgentTraceView } from '@src/components/assets/editor/agent-trace/AgentTraceView';
import { useAgentTraceDoc } from '@src/components/assets/editor/agent-trace/useAgentTraceDoc';
import { useTraceSkeleton } from '@src/components/assets/editor/agent-trace/useTraceSkeleton';
import type { WorkerType } from '@src/hooks/use-transcript';

import { AnalysisToolbarButtons, type AnalysisControls } from './AnalysisControls';

/**
 * "Execution" view for the transcript lens — the agentic execution trace
 * (skills → agents → tools on a timeline).
 *
 * It is **deterministic** — synthesized straight from the transcript (lanes,
 * segments, call_tree, costs, failures) — so it renders immediately via
 * {@link useTraceSkeleton}, with NO agent-trace skill run required. Running the
 * analysis only *enriches* the view with the judgment layer (goals,
 * divergences, verdict); when an annotated AgentTrace entity exists we prefer
 * it, otherwise we show the raw skeleton. The Run / Refresh / Open controls in
 * the header are that optional enrichment, not a prerequisite.
 */
export function ExecutionView({
  controls,
  workerType,
  sessionId,
}: {
  controls: AnalysisControls;
  workerType: WorkerType;
  sessionId: string | null;
}) {
  const { action } = controls;

  // Annotated trace (skill output) when one exists — richer than the skeleton.
  const annotatedTrace = action.kind === 'open' || action.kind === 'refresh' ? action.trace : null;
  const { doc: annotatedDoc } = useAgentTraceDoc(annotatedTrace?.doc ?? null);

  // Deterministic skeleton — the execution trace itself, always available.
  const { skeleton, error, loading } = useTraceSkeleton(workerType, sessionId);

  // Prefer the annotated doc; fall back to the skeleton while it loads / if the
  // session was never analyzed.
  const doc = annotatedDoc ?? skeleton;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-execution-view">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <AnalysisToolbarButtons controls={controls} />
        {!annotatedDoc && doc && (
          <span className="text-[11px] text-muted-foreground/70">
            Showing the raw execution trace — run analysis to add goals &amp; verdict.
          </span>
        )}
      </div>

      {error && !doc ? (
        <div className="flex flex-1 items-center justify-center text-sm text-destructive">
          Failed to build execution trace: {error}
        </div>
      ) : !doc ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {loading ? 'Building execution trace…' : 'No transcript data.'}
        </div>
      ) : (
        <AgentTraceView doc={doc} />
      )}
    </div>
  );
}
