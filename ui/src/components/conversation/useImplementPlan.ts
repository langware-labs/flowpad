import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgenticProcess, type Conversation, type DockPointerData, FlowMessage, Task, TypeId } from '@sdk';
import { newestBy, useLinkedSessions } from '@src/hooks/conversation/useMessageAutomationSessions';
import { ClaudeAgentOptions } from '@sdk/cli_workers/claude-cli';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessagePointer } from '@sdk/entities/conversation';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { resolveWorkdir } from './apply-project-choice';
import { buildReceiverContextPrompt } from './useMyProcess';
import { PLAN_ROLE, planSessionEntries } from './conversation-session-role';
import { isHubOnly } from '@src/navigation/hub-runtime';

interface UseImplementPlanOptions {
  task: ITask | null | undefined;
  conversationId: string;
  /** The conversation entity: its context links each plan session (`PLAN_ROLE`) to the message it implements. */
  conversation: Conversation | null | undefined;
  /** Pointer list from `conversation.conversationMessageIds`. The hook scans
   *  these to figure out whether *any* message in the thread already has a
   *  plan-implementation session (live or in-flight). Reference-stable while
   *  the underlying Conversation entity hasn't changed. */
  pointers: readonly ConversationMessagePointer[];
  /** Wraps any action that needs a `cwd`/project. When provided, the start-session run is deferred until the
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
 * Implement Plan lifecycle for a conversation.
 *
 * Two halves:
 *   1. **runImplementPlan(messageId)** — spawns an AgenticProcess with the
 *      receiver-context prompt and stamps the FlowMessage TypeId into the
 *      AP's `context_entities` so the new session shows up in Private Context
 *      and the bubble's chip flips to "Open Plan Implementation Session".
 *   2. **openPlanSession** — derived from the plan sessions the conversation
 *      links in its context (`PLAN_ROLE` + message id, fetched by id) plus
 *      a local "pending pointers" map for optimistic immediate flips. Picks
 *      the most-recent visible linked AP; falls back to a pending pointer when the
 *      WS create round-trip hasn't landed yet. One session per conversation,
 *      so every bubble points at the same `openPlanSession` callback.
 */
export function useImplementPlan({
  task,
  conversationId,
  conversation,
  pointers,
  ensureMapped,
}: UseImplementPlanOptions): UseImplementPlanResult {
  const { navigation: dockNavigation } = useDockNavigation();

  // Optimistic flip: messageId → spawned AP's terminalDockPointer. Filled the
  // instant `.save()` resolves so the bubble can render the Open link before
  // the watched query notices the new entity. The watched-query result
  // (`planSessionByMessageId`) takes over once it catches up — pending stays
  // in the map but loses to live in `conversationPlanSession` below.
  const [pendingPlanPointers, setPendingPlanPointers] = useState<Map<string, DockPointerData>>(() => new Map());

  const runImplementPlan = useCallback(
    (messageId: string) => {
      if (!task) return;
      const run = async () => {
        const workdir = await resolveWorkdir(task.project_id);
        if (!workdir) {
          notify.warning({ title: t`Map this conversation to a local project first.` });
          return;
        }
        try {
          const instruction = await buildReceiverContextPrompt(
            task as Task,
            conversationId,
            task.sender_name ?? undefined,
          );
          const fmTypeIdString = new TypeId(FlowMessage.type, messageId).toString();
          const cliConfig = new ClaudeAgentOptions({ permission_mode: 'bypassPermissions' });
          const proc = await new AgenticProcess({
            cli_config: cliConfig.toJson(),
            context_data: { project_id: task.project_id ?? undefined },
            workdir,
            visible: true,
            shared_context_entities: [fmTypeIdString],
          }).save();
          // The conversation learns its plan session — the link the reader below resolves by id.
          await conversation?.shareContextEntities(new TypeId(AgenticProcess.type, proc.id), {
            data: { ...PLAN_ROLE, message_id: messageId },
          });
          setPendingPlanPointers((prev) => {
            const next = new Map(prev);
            next.set(messageId, proc.terminalDockPointer);
            return next;
          });
          await proc.start({ instruction });
          proc.openTerminalDock();
        } catch (err) {
          console.error('[useImplementPlan] failed', err);
          notify.error({ title: t`Failed to start session` });
        }
      };
      if (ensureMapped) ensureMapped(run);
      else void run();
    },
    [task, conversationId, conversation, ensureMapped],
  );

  // The plan sessions the conversation links (`PLAN_ROLE` + message id), fetched by id — never a scan of
  // every process (an unfiltered watch here froze the backend on every conversation open). Only visible
  // PTYs qualify; the newest per message wins.
  const planSessions = useLinkedSessions(conversationId, PLAN_ROLE.role);
  const planSessionByMessageId = useMemo(() => {
    const messageOf = new Map(
      (conversation ? planSessionEntries(conversation) : []).map((e) => [e.processId, e.messageId]),
    );
    const messageIds = (p: AgenticProcess) => {
      const messageId = messageOf.get(String(p.id));
      return messageId ? [messageId] : [];
    };
    return newestBy(planSessions, messageIds, (p) => !!p.visible);
  }, [planSessions, conversation]);

  // One session per conversation: as soon as ANY thread message has a session
  // (live or pending), every spec-bearing bubble flips to point at it. Live
  // wins over pending; among live picks, most-recent wins.
  const conversationPlanSession = useMemo<DockPointerData | null>(() => {
    let bestPointer: DockPointerData | null = null;
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
