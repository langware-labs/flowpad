import { useCallback, useMemo, useState } from 'react';
import { AgenticProcess, dataContext, ProcessKind, TypeId } from '@sdk';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { buildSharedAndPrivateContextSection } from '@src/components/conversation/prompt-building';
import { mostRecentProcess } from '@src/utils/process-recency';
import type { WorkerType as ConversationWorkerType } from '@src/components/conversation/conversation-session-constants';
import type { WorkerType } from '@src/hooks/use-transcript';
import { SESSION_TYPE_BY_WORKER } from './transcript-utils';

/** Fixed first instruction for the analyze-transcript worker. */
const ANALYZE_PROMPT = 'Load this transcript using transcript analyzer and summarise it.';

/**
 * Launch/open lifecycle for the worker session that **analyzes a received
 * transcript** — the transcript-viewer twin of {@link useConversationSession}.
 *
 * A received transcript can't be resumed (it never ran here), so instead of the
 * "open in terminal" affordance we offer a worker that loads the transcript via
 * `transcript_analyzer` and summarises it. The launched worker is stamped
 * `process_type = Analysis` and keyed `target_typeid_str = <sessionType>/<id>`
 * — the same surface-scoped analysis key `useSessionAnalyses` uses — so an
 * already-running analyzer is rediscovered via {@link useProcessesForTarget}
 * (session entities are DB-only / not frontend-writable, so the conversation's
 * shared-context reverse-link isn't available here).
 *
 * Differs from the conversation flow ONLY in prompt and context: a fixed
 * "load + summarise" instruction, and the worker session itself as context.
 * Runs in the current active project (`dataContext.project`).
 */
export function useTranscriptSession(
  workerType: WorkerType,
  sessionId: string | null,
): {
  process: AgenticProcess | null;
  starting: boolean;
  launch: (worker: ConversationWorkerType) => void;
  open: () => void;
} {
  const { navigation } = useDockNavigation();
  const [starting, setStarting] = useState(false);

  const sessionType = SESSION_TYPE_BY_WORKER[workerType];
  const target = sessionId ? `${sessionType}/${sessionId}` : null;
  const { processes } = useProcessesForTarget(target, { processType: ProcessKind.Analysis });
  const process = useMemo(() => mostRecentProcess(processes), [processes]);

  const startLaunch = useCallback(
    async (worker: ConversationWorkerType) => {
      if (!sessionId || !target || starting) return;
      const project = dataContext.project;
      const workdir = project?.fs_storage_mount_path ?? undefined;
      if (!workdir) {
        notify.error({ title: 'No active project', message: 'Open a project to analyze this transcript.' });
        return;
      }
      setStarting(true);
      try {
        const sessTypeId = new TypeId(sessionType, sessionId);
        const ctx = buildSharedAndPrivateContextSection([sessTypeId], []);
        await AgenticProcess.launch({
          workerType: worker,
          workdir,
          projectId: project?.id ?? undefined,
          launchPrompt: ctx ? `${ANALYZE_PROMPT}\n\n${ctx}` : ANALYZE_PROMPT,
          enableAssistant: true,
          processType: ProcessKind.Analysis,
          sharedContextEntities: [sessTypeId.toString()],
          target,
        });
      } catch (err) {
        console.error('[useTranscriptSession] start session failed', err);
        notify.error({ title: 'Failed to start session' });
      } finally {
        setStarting(false);
      }
    },
    [sessionId, target, sessionType, starting],
  );

  // Fire-and-forget wrapper: callers hand `launch` straight to an onClick, and a
  // promise-returning handler there is unhandled-rejection bait (the async body
  // already notifies on its own failures).
  const launch = useCallback(
    (worker: ConversationWorkerType) => {
      void startLaunch(worker);
    },
    [startLaunch],
  );

  const open = useCallback(() => {
    if (!process?.id) return;
    void navigation.openShellProcess(process.id);
  }, [process, navigation]);

  return { process, starting, launch, open };
}
