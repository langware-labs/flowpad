import { useMemo } from 'react';
import { AgentTrace, AgenticProcess, ProcessKind, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';

/**
 * Everything the transcript view needs to drive the analysis controls for a
 * worker session:
 *  - all AgentTrace records produced for this session (newest first),
 *  - the AgenticProcess that owns the session (if any — the analysis target),
 *  - the ANALYSIS-kind processes already keyed to that target.
 *
 * The analysis target key: the owning process's typeid when it exists (so the
 * analysis becomes its child via `pair_analysis_context`), else a stable
 * surface-scoped key `claude_session/<sessionId>` (panel/history still work;
 * no parent pairing).
 */
const EMPTY_TRACES: AgentTrace[] = [];

export function useSessionAnalyses(
  sessionId: string | null,
  options: { analysisTargetOverride?: string | null } = {},
) {
  const analysisTargetOverride = options.analysisTargetOverride ?? null;
  // useEntitiesQuery dereferences the request even when disabled — always
  // build one; the sentinel never matches anything and the query is disabled.
  const sid = sessionId ?? '__none__';
  const tracesQuery = useMemo(
    () =>
      new QueryRequest({
        type: AgentTrace.type,
        scope: [],
        name: `agentTracesForSession:${sid}`,
        query: new QueryFilter({ match: { session_id: sid } }),
      }),
    [sid],
  );
  // Unordered — deriveAnalysisAction picks the newest itself.
  const { data: tracesRaw } = useEntitiesQuery<AgentTrace>(tracesQuery, {
    enabled: !!sessionId,
  });
  const traces = tracesRaw ?? EMPTY_TRACES;

  const ownerQuery = useMemo(
    () =>
      new QueryRequest({
        type: AgenticProcess.type,
        scope: [],
        name: `processForSession:${sid}`,
        query: new QueryFilter({ match: { session_id: sid } }),
      }),
    [sid],
  );
  const { data: ownerProcesses } = useEntitiesQuery<AgenticProcess>(ownerQuery, {
    enabled: !!sessionId && !analysisTargetOverride,
  });
  const owningProcess = ownerProcesses?.[0] ?? null;

  let analysisTarget: string | null = null;
  if (sessionId) {
    if (analysisTargetOverride) {
      analysisTarget = analysisTargetOverride;
    } else if (owningProcess) {
      analysisTarget = owningProcess.typeId.toString();
    } else {
      analysisTarget = `claude_session/${sessionId}`;
    }
  }

  const { processes: analysisProcesses } = useProcessesForTarget(analysisTarget, {
    processType: ProcessKind.Analysis,
  });

  return { traces, analysisTarget, analysisProcesses };
}
