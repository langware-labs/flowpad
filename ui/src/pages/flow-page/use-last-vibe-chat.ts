import { AgenticProcess } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useRef } from 'react';
import { lastVibeChatQuery, pickLastVibeChat } from './vibe-process-resolver';

export { lastVibeChatQuery, pickLastVibeChat } from './vibe-process-resolver';

/**
 * "Open the chat I was last in" — the Vibe-mode target of the rail's Chats icon.
 *
 * Vibe has no chats LIST (that is Standard's surface); its Chats icon resumes the
 * user's last real workspace session in the active project. The hard part is
 * "real": this instance also runs background agentic processes, and those must
 * never win. Two hints already on the entity settle it:
 *
 *   - `process_type == ProcessKind.Chat` — excludes execution / analysis /
 *     wizard / conversation processes, i.e. everything that isn't a chat surface.
 *   - the highest non-null `last_active_at` — this field is stamped by
 *     `Entity.activate()`, which is fired ONLY from the process dock loader
 *     (`routes/loaders/load-process.ts`). So it means, precisely, "was opened in
 *     the UI". A background run that never had a dock URL loaded has no stamp and
 *     is filtered out; a chat opened long ago but never since ranks below one
 *     opened recently, regardless of which produced transcript bytes last.
 *
 * Deliberately NOT built on useChatHistory/useWorkerHistory (the source the vibe
 * hero's recent-sessions list uses): that list is transcript-recency-first and
 * carries no `process_type`, so a chatty background run outranks the real chat.
 *
 * The query is one-shot on click rather than a mounted subscription — the rail is
 * on every screen and this answer is only needed at the moment of the click.
 * Opening reuses the proven path from `vibe-recent-sessions.tsx`: navigate to the
 * process's terminal dock with the Vibe skin pinned (a process whose project
 * remembers Standard would otherwise drop the user out of vibe).
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
