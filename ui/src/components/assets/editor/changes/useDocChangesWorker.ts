import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgenticProcess, dataContext, ProcessKind, ProcessStatus, TypeId, WorkerStatus } from '@sdk';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { buildSharedAndPrivateContextSection } from '@src/components/conversation/prompt-building';
import { mostRecentProcess } from '@src/utils/process-recency';
import apiClient from '@sdk/client';
import { useEntity } from '@sdk/react/hooks';
import { useLastWorkerType } from '@src/components/terminal/openers/useLastWorkerType';
import { unsentChanges, useDocChangeList, useDocChangesStore, type DocChange } from './use-doc-changes-store';

/**
 * The one prompt Execute sends: the doc, then every queued change as the quoted
 * text and the instruction for it, in the order they were marked.
 */
export function buildChangesPrompt(
  doc: string,
  docName: string,
  docFile: string,
  changes: readonly DocChange[],
): string {
  const items = changes
    .map((c, i) => `${i + 1}. Where it says:\n   > ${c.quote.replace(/\n/g, '\n   > ')}\n   Change: ${c.instruction}`)
    .join('\n\n');
  const what = changes.length === 1 ? 'this change request' : `these ${changes.length} change requests`;
  const intro =
    `Apply ${what} to the document ${docName}.\n` +
    `The document is the file ${docFile} — edit THAT file in place (not the entity's record folder). ` +
    `Each request quotes the text it is about; leave everything else as it is. ` +
    `If a quote no longer matches, find the closest passage and say so.`;
  const ctx = buildSharedAndPrivateContextSection([new TypeId(doc)], []);
  return [intro, items, ctx].filter(Boolean).join('\n\n');
}

/**
 * Docs whose run THIS page is streaming right now (a reused idle worker): the
 * stream's end settles them, so the watcher stays out until then. After a
 * reload the set is empty and the watcher takes over.
 */
const streaming = new Set<string>();
/** Docs with a settle request in flight — one at a time. */
const settling = new Set<string>();

interface FreshProcess {
  busy?: boolean;
  worker_status?: string | null;
  status?: string | null;
  queue?: { entries?: unknown[] } | null;
}

const TERMINAL_WORKER = new Set<string>([WorkerStatus.COMPLETE, WorkerStatus.ERROR, WorkerStatus.INTERRUPTED]);

export type SentTurnOutcome = 'running' | 'settle' | 'failed';

/**
 * Whether the run that received the list looks over, from the (possibly
 * cached) process. `settle` means "ask the server": cached statuses lag and can
 * still show the previous turn's verdict, so this never calls a run done.
 * A worker launched for the list settles once it reports any final status; a
 * reused one only after it was seen busy since the send and is idle again.
 */
export function sentTurnOutcome(
  p: Pick<AgenticProcess, 'busy' | 'status' | 'worker_status' | 'queue'>,
  list: { fresh?: boolean; started?: boolean },
): SentTurnOutcome {
  if (p.status === ProcessStatus.FAILED) return 'failed';
  if (p.busy || (p.queue?.entries?.length ?? 0) > 0) return 'running';
  if (list.started) return 'settle';
  if (list.fresh && TERMINAL_WORKER.has(p.worker_status ?? '')) return 'settle';
  return 'running';
}

/**
 * The verdict on an idle run, from the server's own read of the transcript.
 * Only `complete` is done. Anything else on an idle worker — interrupted,
 * error, or a turn that ended without a verdict (a model refusal reads
 * "working") — did not finish, and its changes go back to the list.
 */
export function settleVerdict(p: FreshProcess): 'running' | 'done' | 'failed' {
  if (p.status === ProcessStatus.FAILED) return 'failed';
  if (p.busy || (p.queue?.entries?.length ?? 0) > 0) return 'running';
  return p.worker_status === WorkerStatus.COMPLETE ? 'done' : 'failed';
}

async function settleRun(doc: string, processId: string, batch: number | undefined, onRunFinished?: () => void) {
  if (settling.has(doc)) return;
  settling.add(doc);
  try {
    const fresh = await apiClient.get<FreshProcess>(`/api/v1/graph/agentic_process/${processId}`).catch(() => null);
    const store = useDocChangesStore.getState();
    const now = store.byDoc[doc];
    // The list moved on meanwhile (cleared, or another batch sent): not ours to decide.
    if (!fresh || now?.sentTo !== processId || now.batch !== batch) return;
    const verdict = settleVerdict(fresh);
    if (verdict === 'running') return;
    if (verdict === 'done') {
      store.finishRun(doc);
      onRunFinished?.();
      return;
    }
    store.failRun(doc);
    notify.error({
      title: t`The changes did not finish`,
      message: t`They are still in the list — Execute to try again.`,
    });
  } finally {
    settling.delete(doc);
  }
}

/**
 * Context worker for a doc's queued changes — the twin of `useNoteWorker`. The
 * worker is an Analysis process targeted at the doc: an existing one is reused
 * (the list goes in as its next turn), otherwise one is launched with it. When
 * that turn ends the sent changes leave the list; when it fails they stay to retry.
 */
export function useDocChangesWorker(doc: string | null, docName: string, docFile: string, onRunFinished?: () => void) {
  const { navigation } = useDockNavigation();
  const { lastWorker } = useLastWorkerType();
  const list = useDocChangeList(doc);
  const [starting, setStarting] = useState(false);
  const { processes } = useProcessesForTarget(doc, { enabled: !!doc, processType: ProcessKind.Analysis });
  // The worker this doc last used (a New session replaces it), else the most recent one.
  const existing = useMemo(
    () => processes.find((p) => p.id === list.worker) ?? mostRecentProcess(processes),
    [processes, list.worker],
  );

  // Watch the process the list was sent to: its own live entity (re-renders on
  // every status patch), falling back to the doc's process list until it loads.
  const sentTypeId = useMemo(() => (list.sentTo ? new TypeId(AgenticProcess.type, list.sentTo) : null), [list.sentTo]);
  const { data: watched } = useEntity<AgenticProcess>(sentTypeId, { watch: true });
  const sentProcess = useMemo(
    () => (list.sentTo ? (watched ?? processes.find((p) => p.id === list.sentTo) ?? null) : null),
    [watched, processes, list.sentTo],
  );
  // A process may be patched in place, so its identity need not change on a
  // status flip — key the effect on the fields it reads instead.
  const busy = sentProcess?.busy === true;
  const workerStatus = sentProcess?.worker_status ?? null;
  const status = sentProcess?.status ?? null;
  const queued = sentProcess?.queue?.entries?.length ?? 0;

  useEffect(() => {
    if (!doc || !list.sentTo || !sentProcess || sentProcess.id !== list.sentTo) return;
    if (streaming.has(doc)) return;
    const store = useDocChangesStore.getState();
    if (busy) store.markStarted(doc);
    const outcome = sentTurnOutcome(
      { busy, worker_status: workerStatus, status: status ?? sentProcess.status, queue: sentProcess.queue },
      list,
    );
    if (outcome === 'running') return;
    if (outcome === 'settle') {
      void settleRun(doc, list.sentTo, list.batch, onRunFinished);
      return;
    }
    store.failRun(doc);
    notify.error({
      title: t`The changes did not finish`,
      message: t`They are still in the list — Execute to try again.`,
    });
  }, [doc, list, sentProcess, busy, workerStatus, status, queued, onRunFinished]);

  /** `newSession`: skip the doc's worker (e.g. one that keeps refusing) and launch a fresh one. */
  const execute = useCallback(
    async (opts?: { newSession?: boolean }) => {
      const LOG = '[useDocChangesWorker]';
      const pending = unsentChanges(list);
      if (!doc || starting || pending.length === 0) return;
      const prompt = buildChangesPrompt(doc, docName, docFile, pending);
      const store = useDocChangesStore.getState();
      // A run in flight lives on its worker: the next batch goes to the same one.
      const target = opts?.newSession
        ? null
        : list.sentTo
          ? (processes.find((p) => p.id === list.sentTo) ?? existing)
          : existing;
      setStarting(true);
      try {
        if (target) {
          // Mark first: the rows must read "Sent" while the worker works. The
          // run counts as started only once the worker is SEEN busy (watched
          // above) — never presumed, or a stale idle snapshot reads as done.
          // An idle worker runs the batch now and promptOrEnqueue resolves when
          // that turn has streamed; a busy one queues it and resolves at once.
          // A queued batch is decided by the watcher. A streamed one is decided
          // here when its stream ends, from the server's fresh status — a turn
          // stopped twice in a row looks identical to the previous stop in any
          // cached status, but the server reads this turn's transcript.
          const queued = target.busy === true || target.isPrompting || !!list.sentTo;
          store.markSent(doc, target.id, false);
          const batch = useDocChangesStore.getState().byDoc[doc]?.batch;
          if (!queued) streaming.add(doc);
          void target
            .promptOrEnqueue(prompt)
            .then(async () => {
              if (queued) return;
              streaming.delete(doc);
              // The streamed turn is over (finished or stopped): ask the server how it ended.
              useDocChangesStore.getState().markStarted(doc);
              await settleRun(doc, target.id, batch, onRunFinished);
            })
            .catch((err) => {
              streaming.delete(doc);
              console.error(`${LOG} promptOrEnqueue failed`, err);
              useDocChangesStore.getState().failRun(doc);
              notify.error({
                title: t`Failed to send the changes`,
                message: t`They are still in the list — Execute to try again.`,
              });
            });
          return;
        }
        const project = dataContext.project;
        const workdir = project?.fs_storage_mount_path ?? undefined;
        if (!workdir) {
          notify.error({ title: t`No active project`, message: t`Open a project to run these changes.` });
          return;
        }
        const process = await AgenticProcess.launch({
          workerType: lastWorker ?? 'claude_code',
          workdir,
          projectId: project?.id ?? undefined,
          launchPrompt: prompt,
          enableAssistant: true,
          processType: ProcessKind.Analysis,
          sharedContextEntities: [doc],
          target: doc,
        });
        store.markSent(doc, process.id, true);
      } catch (err) {
        console.error(`${LOG} execute failed`, err);
        notify.error({ title: t`Failed to start session` });
      } finally {
        setStarting(false);
      }
    },
    [doc, docName, docFile, starting, list, processes, existing, lastWorker, onRunFinished],
  );

  const sessionId = list.sentTo ?? existing?.id ?? null;
  const open = useCallback(() => {
    if (sessionId) void navigation.openShellProcess(sessionId);
  }, [sessionId, navigation]);

  return { list, starting, execute, open, hasSession: !!sessionId };
}
