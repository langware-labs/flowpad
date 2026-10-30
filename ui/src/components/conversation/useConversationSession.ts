import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgenticProcess, Conversation, FlowMessage, ProcessKind, TypeId, isProcessFailed } from '@sdk';
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
 *  - `launch(worker)` sends the prompt to the conversationProcess when one of
 *    that worker type exists and has not failed (queued if it is busy), and
 *    opens it. Only otherwise does it start a new session in the conversation's
 *    project — wrapped in `ensureMapped`, so an unmapped conversation opens the
 *    project picker first and the launch continues once a project is chosen.
 *  - `open()` navigates to the live shell of the existing conversationProcess.
 */
export function useConversationSession(opts: {
  conversation: Conversation | null;
  ensureMapped?: (
    continuation: () => void | Promise<void>,
    opts?: { onSkip?: () => void | Promise<void> },
  ) => void;
  /** Builds the first instruction placed on the worker's queue. The drawer
   *  supplies the full context-aware prompt; the header a lighter one. */
  buildPrompt: () => string;
}): {
  conversationProcess: AgenticProcess | null;
  starting: boolean;
  /** `prompt` overrides `buildPrompt` for this one launch (e.g. a message's ⋮ menu);
   *  `messageId` stamps that message on the session, which shows as a chip on it. */
  launch: (worker: WorkerType, prompt?: () => string, messageId?: string) => void;
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
      processTids.map(
        (t) =>
          AgenticProcess.getByIdFromCache<AgenticProcess>(t.id) ??
          AgenticProcess.getById<AgenticProcess>(t.id).catch(() => null),
      ),
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
    async (workerType: WorkerType, prompt: () => string = buildPrompt, messageId?: string, scratch = false) => {
      if (!conversation || starting) return;
      // The conversation owns the project (conversation.project_id). A worker
      // starts on the conversation's project and is linked back via the generic
      // shared-context interface — no task, no my_process_id.
      // "Run (Skip project)": no workdir — the backend runs it in the instance's temp folder.
      const workdir = scratch ? undefined : await resolveWorkdir(conversation.project_id);
      // No warn-and-bail: launch is always entered through `ensureMapped`, which
      // opens the picker when unmapped and only runs this after a project lands.
      // A null workdir here means the user cancelled the picker — just stop.
      if (!workdir && !scratch) return;
      setStarting(true);
      try {
        const instruction = prompt();
        const convTypeIdString = conversation.id
          ? new TypeId(Conversation.type, conversation.id).toString()
          : undefined;
        // Every launch keys the process to the conversation (the chip query matches on it); a
        // message launch also stamps the message —
        // `useMessageSessions` reads that back as the chip on the message.
        const messageTypeIdString = messageId ? new TypeId(FlowMessage.type, messageId).toString() : undefined;
        const shared = [convTypeIdString, messageTypeIdString].filter((x): x is string => !!x);
        // Run in the conversation's OWN project (workdir) with the Flowpad
        // Assistant mounted, route the first prompt through the queue, and stamp
        // the Conversation kind so the header/drawer recognise it as THE
        // conversation process.
        const proc = await AgenticProcess.launch({
          workerType,
          workdir,
          projectId: scratch ? undefined : (conversation.project_id ?? undefined),
          scratch,
          launchPrompt: instruction,
          title: conversation.title?.trim() || undefined,
          enableAssistant: true,
          processType: ProcessKind.Conversation,
          sharedContextEntities: shared.length ? shared : undefined,
          ...(convTypeIdString ? { target: convTypeIdString } : {}),
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
        notify.error({ title: t`Failed to start session` });
      } finally {
        setStarting(false);
      }
    },
    [conversation, starting, buildPrompt],
  );

  // `launch` reads the process through a ref so status churn doesn't change its identity.
  const processRef = useRef(conversationProcess);
  processRef.current = conversationProcess;

  const sendToSession = useCallback(
    (target: AgenticProcess, prompt: () => string = buildPrompt, messageId?: string) => {
      // A message launch stamps the message on the session: its chip shows on the message.
      const stamped = messageId ? target.shareContextEntities(new TypeId(FlowMessage.type, messageId)) : Promise.resolve();
      void navigation.openShellProcess(target.id);
      // Idle: runs now (resolves when the turn ends). Busy: queued.
      stamped
        .then(() => target.promptOrEnqueue(prompt()))
        .catch((err) => {
          console.error('[useConversationSession] send to session failed', err);
          notify.error({ title: t`Failed to send to the session` });
        });
    },
    [buildPrompt, navigation],
  );

  const launch = useCallback(
    (worker: WorkerType, prompt?: () => string, messageId?: string) => {
      // Reuse the conversation's own session: same worker type, not failed.
      const existing = processRef.current;
      if (existing && existing.worker_type === worker && !isProcessFailed(existing.status)) {
        sendToSession(existing, prompt, messageId);
        return;
      }
      const run = () => startSession(worker, prompt, messageId);
      if (ensureMapped) ensureMapped(run, { onSkip: () => startSession(worker, prompt, messageId, true) });
      else void run();
    },
    [startSession, sendToSession, ensureMapped],
  );

  const open = useCallback(() => {
    if (!conversationProcess?.id) return;
    void navigation.openShellProcess(conversationProcess.id);
  }, [conversationProcess, navigation]);

  return { conversationProcess, starting, launch, open };
}
