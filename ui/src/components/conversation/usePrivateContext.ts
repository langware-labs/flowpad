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
 * new entity's `context_entities` (Tasks) or as `target_vfs_path` (AgenticProcess
 * sessions started from this message's transcript).
 */
export interface PrivateContextItems {
  tasks: Task[];
  processes: AgenticProcess[];
}

/**
 * Resolves Private Context entities for a FlowMessage:
 *
 * - **Tasks**: query Tasks for the conversation's project, then filter
 *   client-side to those whose `contextEntities` reference the FlowMessage.
 *   (Backend has no `$CONTAINS` operator on list fields today; the project
 *   scope keeps the candidate set small enough for client-side filtering.)
 *
 * - **AgenticProcesses**: query directly by `target_vfs_path = <fm typeid>` —
 *   the "Start CC from transcript" handler stamps that field, so this picks up
 *   exactly the sessions started from this message.
 */
export function usePrivateContext(
  flowMessageId: string | null,
  projectId?: string | null,
): PrivateContextItems {
  // ── Tasks ────────────────────────────────────────────────────────────
  const tasksQuery = useMemo(() => {
    if (!flowMessageId) return null;
    const match: Record<string, unknown> = {};
    if (projectId) match.project_id = projectId;
    return new QueryRequest({
      type: Task.type,
      scope: [],
      name: `private-context-tasks:${flowMessageId}:${projectId ?? 'noproj'}`,
      query: new QueryFilter({ match }),
    });
  }, [flowMessageId, projectId]);
  const { data: candidateTasks = [] } = useEntitiesQuery<Task>(tasksQuery as QueryRequest, {
    enabled: !!tasksQuery,
  });

  const tasks = useMemo(() => {
    if (!flowMessageId) return [] as Task[];
    const fmKey = new TypeId(FlowMessage.type, flowMessageId).toString();
    return candidateTasks.filter((t) =>
      t.contextEntities?.some((tid) => tid.toString() === fmKey),
    );
  }, [candidateTasks, flowMessageId]);

  // ── AgenticProcesses (transcript-derived CC sessions) ────────────────
  const fmKey = flowMessageId ? new TypeId(FlowMessage.type, flowMessageId).toString() : '';
  const processQuery = useMemo(() => {
    if (!fmKey) return null;
    return new QueryRequest({
      type: AgenticProcess.type,
      scope: [],
      name: `private-context-processes:${fmKey}`,
      query: new QueryFilter({ match: { target_vfs_path: fmKey } as Record<string, unknown> }),
    });
  }, [fmKey]);
  const { data: processes = [] } = useEntitiesQuery<AgenticProcess>(processQuery as QueryRequest, {
    enabled: !!processQuery,
  });

  return { tasks, processes };
}
