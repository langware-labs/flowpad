import { useEffect, useMemo, useRef } from 'react';
import { useWorkerHistory } from '@src/hooks/useWorkerHistory';
import { useFlowpadAssistantProject } from './useFlowpadAssistantProject';

/**
 * Total message count across the user's Flowpad Assistant conversations — the
 * number shown on the assistant-button badge. 0 when no assistant chat has any
 * messages yet, so the caller hides the badge entirely.
 *
 * Sourced from `worker-history` scoped to the assistant project: the same
 * per-session `message_count` the panel's "Past chats" rows show, and the
 * reliable source here (older chats have no live `AgenticProcess` row but still
 * carry a session count). worker-history deliberately fetches once and does NOT
 * auto-refetch on process ops, so we refresh when the chat closes to reflect a
 * just-finished exchange.
 *
 * @param chatOpen whether the floating chat window is currently open.
 */
export function useAssistantMessageCount(chatOpen: boolean): number {
  const { project } = useFlowpadAssistantProject();
  const projectIds = useMemo(() => (project?.id ? [project.id] : undefined), [project?.id]);
  const { entries, refetch } = useWorkerHistory(100, { projectIds, enabled: !!project?.id });

  const wasOpen = useRef(chatOpen);
  useEffect(() => {
    // Chat just closed → the conversation may have grown; refresh the count.
    if (wasOpen.current && !chatOpen) void refetch();
    wasOpen.current = chatOpen;
  }, [chatOpen, refetch]);

  return useMemo(
    () => entries.reduce((sum, e) => sum + (e.message_count ?? 0), 0),
    [entries],
  );
}
