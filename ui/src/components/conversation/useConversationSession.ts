import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgenticProcess, Conversation, ProcessKind, TypeId } from '@sdk';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { mostRecentProcess } from '@src/utils/process-recency';
import { resolveWorkdir } from './apply-project-choice';
import type { WorkerType } from './conversation-session-constants';

/**
 * The single launch/open lifecycle for a conversation's owning worker session.
 *
 * A conversation has at most one "conversationProcess" — an AgenticProcess
 * stamped with `process_type === ProcessKind.Conversation`, linked onto the
 * conversation's `sharedContextEntities` at launch time. This hook is the one
 * source of truth shared by the conversation header and the Context drawer so
 * the two never disagree: a conversationProcess is present (⇒ Open) or absent
 * (⇒ launch toolbar) — never neither.
 *
 *  - `launch(worker)` starts a session in the conversation's project. It is
 *    wrapped in `ensureMapped`, so an unmapped conversation opens the project
 *    picker first and the launch continues automatically once a project is
 *    chosen.
 *  - `open()` navigates to the live shell of the existing conversationProcess.
 */
export function useConversationSession(opts: {
  conversation: Conversation | null;
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** Builds the first instruction placed on the worker's queue. The drawer
   *  supplies the full context-aware prompt; the header a lighter one. */
  buildPrompt: () => string;
}): {
  conversationProcess: AgenticProcess | null;
  starting: boolean;
  launch: (worker: WorkerType) => void;
  open: () => void;
} {
  const { conversation, ensureMapped, buildPrompt } = opts;
  const { navigation } = useDockNavigation();
  const [starting, setStarting] = useState(false);

  // The conversationProcess is whatever AgenticProcess is linked directly on the
  // conversation (startSession links it there) and carries the Conversation
  // kind. On a cold load the linked process isn't necessarily in the entity
  // cache yet — so we FETCH each linked agentic_process by id (cache-first,
  // network fallback) into local state rather than reading cache-only, which
  // would render the launch toolbar until something else happened to fetch it.
  //
  // Key on the shared-entity CONTENT, not the entity ref: shareContextEntities
  // mutates the conversation in place (same object identity), so a ref-only dep
  // would miss the new link after a launch.
  const processTids = conversation?.contextOfType(AgenticProcess.type, 'shared') ?? [];
  const sharedKey = processTids.map((t) => t.toString()).join(',');
  const [linkedProcesses, setLinkedProcesses] = useState<AgenticProcess[]>([]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      processTids.map((t) => AgenticProcess.getByIdFromCache<AgenticProcess>(t.id) ?? AgenticProcess.getById<AgenticProcess>(t.id).catch(() => null)),
    ).then((procs) => {
      if (!cancelled) setLinkedProcesses(procs.filter((p): p is AgenticProcess => !!p));
    });
    return () => {
      cancelled = true;
    };
    // processTids is rebuilt each render; sharedKey is the stable content key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedKey]);

  const conversationProcess = useMemo<AgenticProcess | null>(
    () => mostRecentProcess(linkedProcesses.filter((p) => p.process_type === ProcessKind.Conversation)),
    [linkedProcesses],
  );

  const startSession = useCallback(
    async (workerType: WorkerType) => {
      if (!conversation || starting) return;
      // The conversation owns the project (conversation.project_id). A worker
      // starts on the conversation's project and is linked back via the generic
      // shared-context interface — no task, no my_process_id.
      const workdir = await resolveWorkdir(conversation.project_id);
      // No warn-and-bail: launch is always entered through `ensureMapped`, which
      // opens the picker when unmapped and only runs this after a project lands.
      // A null workdir here means the user cancelled the picker — just stop.
      if (!workdir) return;
      setStarting(true);
      try {
        const instruction = buildPrompt();
        const convTypeIdString = conversation.id
          ? new TypeId(Conversation.type, conversation.id).toString()
          : undefined;
        // Run in the conversation's OWN project (workdir) with the Flowpad
        // Assistant mounted, route the first prompt through the queue, and stamp
        // the Conversation kind so the header/drawer recognise it as THE
        // conversation process.
        const proc = await AgenticProcess.launch({
          workerType,
          workdir,
          projectId: conversation.project_id ?? undefined,
          launchPrompt: instruction,
          enableAssistant: true,
          processType: ProcessKind.Conversation,
          sharedContextEntities: convTypeIdString ? [convTypeIdString] : undefined,
        });
        // Save the worker into the conversation's context so it surfaces as the
        // conversationProcess and is the target for per-message append.
        if (proc.id) {
          try {
            await conversation.shareContextEntities(new TypeId(AgenticProcess.type, proc.id));
          } catch (linkErr) {
            console.error('[useConversationSession] failed to link process to conversation', linkErr);
          }
        }
      } catch (err) {
        console.error('[useConversationSession] start session failed', err);
        notify.error({ title: 'Failed to start session' });
      } finally {
        setStarting(false);
      }
    },
    [conversation, starting, buildPrompt],
  );

  const launch = useCallback(
    (worker: WorkerType) => {
      const run = () => startSession(worker);
      if (ensureMapped) ensureMapped(run);
      else void run();
    },
    [startSession, ensureMapped],
  );

  const open = useCallback(() => {
    if (!conversationProcess?.id) return;
    void navigation.openShellProcess(conversationProcess.id);
  }, [conversationProcess, navigation]);

  return { conversationProcess, starting, launch, open };
}
