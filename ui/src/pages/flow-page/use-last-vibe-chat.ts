import { AgenticProcess, ProcessKind, QueryFilter, QueryRequest } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { mostRecentProcess } from '@src/utils/process-recency';
import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';

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
/**
 * The candidate query: this project's chat processes that were opened in the UI
 * at least once. Exported so the API-tier test can prove the FILTER against a
 * real backend rather than restating it.
 */
export function lastVibeChatQuery(projectId: string): QueryRequest {
  return new QueryRequest({
    type: AgenticProcess.type,
    // Project membership is the `project_id` FIELD, not graph scope. An
    // AgenticProcess is not a scoped descendant of its project the way an asset
    // is — passing `scope: [TypeId(project, id)]` here matches zero rows against
    // real data (verified in the running app: scoped-nofilter → 0 while
    // unscoped → 67). Filtering on the field is the association that exists.
    scope: [],
    name: `lastVibeChat:${projectId}`,
    query: new QueryFilter({
      match: {
        op: '$AND',
        operands: [
          { op: '$EQ', operands: ['project_id', projectId] },
          { op: '$EQ', operands: ['process_type', ProcessKind.Chat] },
          // Unary form — IS_NOT_NULL takes the field as its only operand.
          { op: '$IS_NOT_NULL', operands: ['last_active_at'] },
        ],
      },
    }),
  });
}

/**
 * Most-recently-opened of the candidates — the shared recency helper, which also
 * normalises an ISO-string `last_active_at` (the field is `number | string | null`).
 *
 * Ranking happens HERE rather than as `order_by: { last_active_at: 'desc' }` +
 * `limit: 1` on the query, because that ordering does not survive the client
 * query path. Measured against a real backend (2026-07-23): with two rows stamped
 * OLD then NEW, `order_by desc` returned them ascending and `limit: 1` returned
 * the OLDER one. The driver's own sort path looks correct on inspection, so the
 * order is most likely dropped between the query and the client store — either
 * way it is not observable through `AgenticProcess.query`, so callers must not
 * depend on it. The candidate set is one project's UI-opened chats, so ranking
 * client-side is cheap.
 */
export const pickLastVibeChat = mostRecentProcess;

export function useLastVibeChat(): () => void {
  const { project } = useProject();
  const { navigation } = useDockNavigation();
  const navigate = useNavigate();
  const projectId = project?.id ?? null;
  // The resolve is async; without this a double-click fires two queries and two
  // navigations (same guard as useResumeInTerminal / VibeRecentSessions).
  const busyRef = useRef(false);

  return useCallback(() => {
    if (busyRef.current) return;
    // No project → nothing to scope to; the hero is the only sensible landing.
    if (!projectId) {
      void navigate('/');
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
          void navigate('/');
          return;
        }
        navigation.openDockPointer(last.terminalDockPointer, { viewMode: ViewMode.Vibe });
      } catch (error) {
        console.error('[Vibe] failed to resolve the last chat', error);
        void navigate('/');
      } finally {
        busyRef.current = false;
      }
    })();
  }, [projectId, navigate, navigation]);
}
