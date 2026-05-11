import { useMemo } from 'react';
import {
  AgenticProcess,
  FlowMessage,
  QueryFilter,
  QueryRequest,
  Task,
  TypeId,
} from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';

/**
 * Items the local user has explicitly added to a FlowMessage's "private
 * context" — Tasks Claude derived headlessly, CC sessions started from a
 * transcript, etc. Linkage is stored as the source FlowMessage TypeId in the
 * new entity's `context_entities`.
 */
export interface PrivateContextItems {
  tasks: Task[];
  processes: AgenticProcess[];
}

/**
 * Resolves Private Context entities for a FlowMessage. Both queries use the
 * same shape: scope by `project_id` to keep the candidate set small, then
 * filter client-side to those whose `contextEntities` reference the
 * FlowMessage. Backend has no `$CONTAINS` operator on list fields, and a
 * post-spawn UPDATE that flips an entity into a backend filter doesn't
 * reliably re-add it to live query results — client-side filtering avoids
 * both limitations.
 *
 * `useEntitiesQuery` dereferences `.query` on its first arg, so the request
 * must always be a real `QueryRequest`. We gate execution via the `enabled`
 * flag and return safe placeholders when there's no flow-message id.
 */
export function usePrivateContext(
  flowMessageId: string | null,
  projectId?: string | null,
): PrivateContextItems {
  const fmKey = flowMessageId
    ? new TypeId(FlowMessage.type, flowMessageId).toString()
    : '';

  // ── Tasks ────────────────────────────────────────────────────────────
  const tasksQuery = useMemo(() => {
    const match: Record<string, unknown> = {};
    if (projectId) match.project_id = projectId;
    return new QueryRequest({
      type: Task.type,
      scope: [],
      name: `private-context-tasks:${flowMessageId ?? 'none'}:${projectId ?? 'noproj'}`,
      query: new QueryFilter({ match }),
    });
  }, [flowMessageId, projectId]);
  const { data: candidateTasks = [] } = useEntitiesQuery<Task>(tasksQuery, {
    enabled: !!flowMessageId,
  });

  const tasks = useMemo(() => {
    if (!fmKey) return [] as Task[];
    return candidateTasks.filter((t) =>
      t.contextEntities?.some((tid) => tid.toString() === fmKey),
    );
  }, [candidateTasks, fmKey]);

  // ── AgenticProcesses (transcript-derived sessions) ───────────────────
  // Don't filter by `project_id` server-side: the backend resolves
  // `conv.project_id` from its DB row, which can lag the frontend's local
  // mapping — a freshly-mapped conversation may not yet have project_id
  // synced server-side, so the spawned process gets `project_id=null` and
  // a project-id filter would exclude it. Pull all AgenticProcesses and
  // filter client-side on `contextEntities` containing the FlowMessage
  // (same single-criterion approach Tasks use above).
  const processQuery = useMemo(() => {
    return new QueryRequest({
      type: AgenticProcess.type,
      scope: [],
      name: `private-context-processes:${flowMessageId ?? 'none'}`,
      query: new QueryFilter({ match: {} as Record<string, unknown> }),
    });
  }, [flowMessageId]);
  const { data: candidateProcesses = [] } = useEntitiesQuery<AgenticProcess>(processQuery, {
    enabled: !!flowMessageId,
  });

  const processes = useMemo(() => {
    if (!fmKey) return [] as AgenticProcess[];
    const filtered = candidateProcesses.filter((p) =>
      p.contextEntities?.some((tid) => tid.toString() === fmKey),
    );
    console.log('[usePrivateContext] process filter:', {
      fmKey,
      candidateCount: candidateProcesses.length,
      candidates: candidateProcesses.map((p) => ({
        id: p.id,
        visible: p.visible,
        contextEntities: p.contextEntities?.map((t) => t.toString()),
      })),
      matchedCount: filtered.length,
    });
    return filtered;
  }, [candidateProcesses, fmKey]);

  return { tasks, processes };
}
