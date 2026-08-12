import { t } from '@lingui/core/macro';
import { useMemo } from 'react';
import { MessagesSquare } from 'lucide-react';
import { AgentTrace, AgenticProcess, Project, TypeId } from '@sdk';
import { ContextProcessButton } from '@src/components/context-process/ContextProcessButton';
import { compactTypeIds } from '@src/components/context-process/contextTypeids';

/**
 * Per-analysis context-process control — declares the analysis's context (the
 * AgentTrace + the analyzed process + project) and delegates to the generic
 * {@link ContextProcessButton}. The analysis surface's consumer of the pattern.
 */
export function AnalysisContextButton({
  trace,
  process,
}: {
  trace: AgentTrace;
  process: AgenticProcess | null;
}) {
  const target = trace.id ? new TypeId(AgentTrace.type, trace.id).toString() : null;
  const analyzedId = trace.analyzed_process_id ?? process?.id ?? null;
  const projectId = process?.project_id ?? null;
  // The trace is the identity entity; the analyzed process + project widen it.
  const contextTypeids = useMemo(
    () =>
      compactTypeIds(
        target,
        analyzedId && new TypeId(AgenticProcess.type, analyzedId).toString(),
        projectId && new TypeId(Project.type, projectId).toString(),
      ),
    [target, analyzedId, projectId],
  );

  return (
    <ContextProcessButton
      target={target}
      contextTypeids={contextTypeids}
      projectId={projectId}
      name={trace.id ? `Analysis ${trace.id.slice(0, 8)}` : undefined}
      copy={{
        icon: MessagesSquare,
        launch: { label: t`Discuss analysis`, tooltip: 'Start a worker with this analysis as context' },
        resume: { label: t`Resume discussion`, tooltip: 'Resume the worker discussing this analysis' },
      }}
    />
  );
}
