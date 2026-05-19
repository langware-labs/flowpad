import { useCallback, useMemo, useState } from 'react';
import {
  AgenticProcess,
  FlowMessage,
  QueryRequest,
  Task,
  TypeId,
} from '@sdk';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';
import { useEntitiesQuery } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessagePointer } from '@sdk/entities/conversation';
import { toast } from 'sonner';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { DockPointer } from '@src/navigation/DockPointer';
import { buildReceiverContextPrompt } from './useMyProcess';

interface UseImplementPlanOptions {
  task: ITask | null | undefined;
  conversationId: string;
  /** Pointer list from `conversation.conversationMessageIds`. The hook scans
   *  these to figure out whether *any* message in the thread already has a
   *  plan-implementation session (live or in-flight). Reference-stable while
   *  the underlying Conversation entity hasn't changed. */
  pointers: readonly ConversationMessagePointer[];
  /** Wraps any action that needs a `cwd`/project — same gate `useApproveAndExecute`
   *  expects. When provided, the start-session run is deferred until the
   *  mapping dialog has resolved. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
}

interface UseImplementPlanResult {
  /** Click handler for the per-bubble Implement Plan chip. Spawns a visible
   *  AgenticProcess pre-loaded with `buildReceiverContextPrompt`, stamps the
   *  FlowMessage TypeId into its `context_entities` up-front, then opens the
   *  terminal dock. Optimistically records the new dock pointer so
   *  `openPlanSession` flips immediately, before the watched-query catches up. */
  runImplementPlan: (messageId: string) => void;
  /** When any message in the thread already has a plan-implementation session
   *  (live OR in-flight from this turn), returns a single callback that opens
   *  that session's terminal dock. Every spec-bearing bubble in the thread
   *  swaps the Implement Plan chip for an "Open Plan Implementation Session"
   *  affordance pointing at this same callback — one session per conversation. */
  openPlanSession: (() => void) | undefined;
}

/**
 * Implement Plan lifecycle for a conversation, parallel to `useApproveAndExecute`.
 *
 * Two halves:
 *   1. **runImplementPlan(messageId)** — spawns an AgenticProcess with the
 *      receiver-context prompt and stamps the FlowMessage TypeId into the
 *      AP's `context_entities` so the new session shows up in Private Context
 *      and the bubble's chip flips to "Open Plan Implementation Session".
 *   2. **openPlanSession** — derived from a live `AgenticProcess` query plus
 *      a local "pending pointers" map for optimistic immediate flips. Picks
 *      the most-recent visible AP whose context_entities include any
 *      FlowMessage from this thread; falls back to a pending pointer when the
 *      WS create round-trip hasn't landed yet. One session per conversation,
 *      so every bubble points at the same `openPlanSession` callback.
 */
export function useImplementPlan({
  task,
  conversationId,
  pointers,
  ensureMapped,
}: UseImplementPlanOptions): UseImplementPlanResult {
  const { navigation: dockNavigation } = useDockNavigation();

  // Optimistic flip: messageId → spawned AP's terminalDockPointer. Filled the
  // instant `.save()` resolves so the bubble can render the Open link before
  // the watched query notices the new entity. The watched-query result
  // (`planSessionByMessageId`) takes over once it catches up — pending stays
  // in the map but loses to live in `conversationPlanSession` below.
  const [pendingPlanPointers, setPendingPlanPointers] = useState<Map<string, DockPointer>>(
    () => new Map(),
  );

  const runImplementPlan = useCallback(
    (messageId: string) => {
      if (!task) return;
      const run = async () => {
        const workdir = task.project_root ?? undefined;
        if (!workdir) {
          toast.warning('Map this conversation to a local project first.');
          return;
        }
        try {
          const instruction = await buildReceiverContextPrompt(
            task as Task,
            conversationId,
            task.sender_name ?? undefined,
          );
          const fmTypeIdString = new TypeId(FlowMessage.type, messageId).toString();
          const cliConfig = new ClaudeCliOptions({ permission_mode: 'bypassPermissions' });
          const proc = await new AgenticProcess({
            cli_config: cliConfig.toJson(),
            context_data: { project_id: task.project_id ?? undefined },
            workdir,
            visible: true,
            shared_context_entities: [fmTypeIdString],
          }).save();
          setPendingPlanPointers((prev) => {
            const next = new Map(prev);
            next.set(messageId, proc.terminalDockPointer);
            return next;
          });
          await proc.start({ instruction });
          proc.openTerminalDock();
        } catch (err) {
          console.error('[useImplementPlan] failed', err);
          toast.error('Failed to start session');
        }
      };
      if (ensureMapped) ensureMapped(run);
      else void run();
    },
    [task, conversationId, ensureMapped],
  );

  // Watched query — any AgenticProcess whose `context_entities` references a
  // FlowMessage in this thread is treated as that message's plan-implementation
  // session. Only visible PTYs qualify (their terminal dock pointer is the
  // only one that's meaningful here); for a tie we keep the most recently
  // created so users land in the latest run after re-clicks.
  const planSessionsQuery = useMemo(
    () => new QueryRequest({
      type: AgenticProcess.type,
      scope: [],
      name: `conv-plan-sessions:${conversationId}`,
      query: undefined,
    }),
    [conversationId],
  );
  const { data: planSessionCandidates = [] } = useEntitiesQuery<AgenticProcess>(planSessionsQuery, {
    enabled: !!conversationId,
  });

  const planSessionByMessageId = useMemo(() => {
    const map = new Map<string, AgenticProcess>();
    for (const p of planSessionCandidates) {
      if (!p.visible) continue;
      for (const tid of p.sharedContextEntities ?? []) {
        if (tid.type !== FlowMessage.type) continue;
        const existing = map.get(tid.id);
        if (!existing || toMs(p.created_date) > toMs(existing.created_date)) {
          map.set(tid.id, p);
        }
      }
    }
    return map;
  }, [planSessionCandidates]);

  // One session per conversation: as soon as ANY thread message has a session
  // (live or pending), every spec-bearing bubble flips to point at it. Live
  // wins over pending; among live picks, most-recent wins.
  const conversationPlanSession = useMemo<DockPointer | null>(() => {
    let bestPointer: DockPointer | null = null;
    let bestTs = -1;
    for (const ptr of pointers) {
      const live = planSessionByMessageId.get(ptr.id);
      if (live) {
        const ts = toMs(live.created_date);
        if (ts >= bestTs) {
          bestTs = ts;
          bestPointer = live.terminalDockPointer;
        }
      }
    }
    if (bestPointer) return bestPointer;
    for (const ptr of pointers) {
      const pending = pendingPlanPointers.get(ptr.id);
      if (pending) return pending;
    }
    return null;
  }, [pointers, planSessionByMessageId, pendingPlanPointers]);

  const openPlanSession = useMemo<(() => void) | undefined>(() => {
    if (!conversationPlanSession) return undefined;
    return () => dockNavigation.openDock(conversationPlanSession);
  }, [conversationPlanSession, dockNavigation]);

  return { runImplementPlan, openPlanSession };
}

function toMs(d: unknown): number {
  if (d instanceof Date) return d.getTime();
  if (typeof d === 'string') return new Date(d).getTime() || 0;
  return 0;
}
