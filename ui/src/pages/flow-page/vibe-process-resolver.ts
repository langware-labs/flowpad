import { AgenticProcess, lastChatQuery } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { mostRecentProcess } from '@src/utils/process-recency';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useRef } from 'react';

/** The latest real Chat opened in this project — the SDK's rule (`lastChatQuery`), shared with served pages. */
export const lastVibeChatQuery = lastChatQuery;

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
        // No mode stated: the session opens in the mode it remembers (its
        // `last_mode`), never forced to Vibe by the screen it is left from.
        navigation.openDockPointer(last.terminalDockPointer);
      } catch (error) {
        console.error('[Vibe] failed to resolve the last chat', error);
        navigation.goHome();
      } finally {
        busyRef.current = false;
      }
    })();
  }, [projectId, navigation]);
}
