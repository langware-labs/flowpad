import { AgenticProcess, type ExpressionNode, ProcessKind, QueryFilter, QueryRequest } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { mostRecentProcess } from '@src/utils/process-recency';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useRef } from 'react';

/** The latest real Chat that was opened in this project (the project home page's
 *  agent resume uses it).
 *  `target` narrows it to one entity's chats — an agent's sessions carry the
 *  agent's TypeId as `target_typeid_str` (`Deployment.use`).
 *  `openedOnly` (default) keeps only chats that were opened; Discuss on an asset
 *  passes false — a chat made by Discuss is the asset's even before its first turn. */
export function lastVibeChatQuery(
  projectId: string,
  target?: string,
  { openedOnly = true }: { openedOnly?: boolean } = {},
): QueryRequest {
  const operands: Partial<ExpressionNode>[] = [
    { op: '$EQ', operands: ['project_id', projectId] },
    { op: '$EQ', operands: ['process_type', ProcessKind.Chat] },
  ];
  if (openedOnly) operands.push({ op: '$IS_NOT_NULL', operands: ['last_active_at'] });
  if (target) operands.push({ op: '$EQ', operands: ['target_typeid_str', target] });
  return new QueryRequest({
    type: AgenticProcess.type,
    scope: [],
    name: `lastVibeChat:${projectId}${target ? `:${target}` : ''}${openedOnly ? '' : ':any'}`,
    query: new QueryFilter({ match: { op: '$AND', operands } }),
  });
}

export const pickLastVibeChat = mostRecentProcess;

/**
 * "Open the chat I was last in" — the Vibe-mode target of the rail's Chats icon.
 *
 * Vibe has no chats LIST (that is Standard's surface); its Chats icon resumes the
 * user's last real workspace session in the active project (see lastVibeChatQuery).
 * The query is one-shot on click rather than a mounted subscription — the rail is
 * on every screen and this answer is only needed at the moment of the click.
 */
export function useLastVibeChat(): () => void {
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const projectId = project?.id ?? null;
  // The resolve is async; without this a double-click fires two queries and two
  // navigations (same guard as useResumeInTerminal / VibeRecentSessions).
  const busyRef = useRef(false);

  return useCallback(() => {
    if (busyRef.current) return;
    // No project → nothing to scope to; the hero is the only sensible landing.
    if (!projectId) {
      navigation.goHome();
      return;
    }
    busyRef.current = true;
    void (async () => {
      try {
        const candidates = await AgenticProcess.query<AgenticProcess>(lastVibeChatQuery(projectId));
        const last = pickLastVibeChat(candidates);
        if (!last) {
          // Nothing ever opened here — the vibe home hero, which already offers
          // the composer and VibeRecentSessions.
          navigation.goHome();
          return;
        }
        navigation.openDockPointer(last.terminalDockPointer, { viewMode: ViewMode.Vibe });
      } catch (error) {
        console.error('[Vibe] failed to resolve the last chat', error);
        navigation.goHome();
      } finally {
        busyRef.current = false;
      }
    })();
  }, [projectId, navigation]);
}
