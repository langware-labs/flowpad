import { t } from '@lingui/core/macro';
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

  // A vendor with no session ENTITY type (opencode) has no analysis target to
  // key on — there is no `<sessionType>/<id>` to rediscover a running analyzer
  // by. Guard the lookup: interpolating the miss produced the literal target
  // string `"undefined/ses_…"`, which matches nothing and would silently spawn a
  // duplicate analyzer on every mount.
  const sessionType = SESSION_TYPE_BY_WORKER[workerType];
  const target = sessionId && sessionType ? `${sessionType}/${sessionId}` : null;
  const { processes } = useProcessesForTarget(target, { processType: ProcessKind.Analysis });
  const process = useMemo(() => mostRecentProcess(processes), [processes]);

  const startLaunch = useCallback(
    async (worker: ConversationWorkerType) => {
      // Every path that returns without a terminal logs why. "Click does
      // nothing and we stay on the transcript page" is the shared symptom of
      // all of them, so the console line is the only way to tell them apart.
      const LOG = '[useTranscriptSession]';
      if (!sessionId || !sessionType || !target || starting) {
        console.warn(
          `${LOG} launch click did NOT open a session — ` +
            `sessionId=${sessionId ?? 'null'} sessionType=${sessionType ?? 'null'} target=${target ?? 'null'} starting=${starting}` +
            (starting ? ' (a previous launch is still in flight and never settled)' : ''),
        );
        return;
      }
      const project = dataContext.project;
      const workdir = project?.fs_storage_mount_path ?? undefined;
      if (!workdir) {
        console.warn(
          `${LOG} launch click did NOT open a session — the active project has no folder on this machine. ` +
            `project=${project?.id ?? 'null'} name=${project?.name ?? 'null'} fs_storage_mount_path=${String(project?.fs_storage_mount_path)}`,
        );
        notify.error({ title: t`No active project`, message: t`Open a project to analyze this transcript.` });
        return;
      }
      setStarting(true);
      console.debug(`${LOG} launching ${worker} for ${target} in ${workdir}…`);
      try {
        const sessTypeId = new TypeId(sessionType, sessionId);
        const ctx = buildSharedAndPrivateContextSection([sessTypeId], []);
        const proc = await AgenticProcess.launch({
          workerType: worker,
          workdir,
          projectId: project?.id ?? undefined,
          launchPrompt: ctx ? `${ANALYZE_PROMPT}\n\n${ctx}` : ANALYZE_PROMPT,
          enableAssistant: true,
          processType: ProcessKind.Analysis,
          sharedContextEntities: [sessTypeId.toString()],
          target,
        });
        console.debug(`${LOG} launched process ${proc?.id ?? 'null'} — terminal dock opened`);
      } catch (err) {
        console.error(`${LOG} launch click did NOT open a session — AgenticProcess.launch threw`, err);
        notify.error({ title: t`Failed to start session` });
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
    if (!process?.id) {
      console.warn(
        '[useTranscriptSession] Open click did NOT open a session — no analysis process resolved for this transcript',
      );
      return;
    }
    console.debug(`[useTranscriptSession] opening existing analysis process ${process.id}`);
    void navigation.openShellProcess(process.id);
  }, [process, navigation]);

  return { process, starting, launch, open };
}
