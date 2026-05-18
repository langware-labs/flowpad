import {
  AgenticProcess,
  Conversation,
  dataManager,
  isWorkerTerminal,
  ProcessStatus,
  TypeId,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ActionInfo } from '@sdk/models/ActionInfo';
import type { ITask } from '@sdk/entities/task';
import type { FlowData } from '@sdk/flow_processing';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { toast } from 'sonner';
import { useProcessesForTarget } from '@src/components/entity-execution-panel';
import { approveAndReload, buildMergedPrompt } from './prompt-building';

interface UseApproveAndExecuteOptions {
  /** Task to scope the run to. Pass an inert task (`{id: '', metadata: {}}`)
   * for hub-direct conversations; `conversationId` drives those. */
  task: ITask;
  /** Required when `task.id` is empty — drives the conversation-scoped variant. */
  conversationId?: string | null;
}

interface UseApproveAndExecuteResult {
  approveAndExecute: (messageId: string, attachmentIndex: number) => Promise<void>;
}

/** Concatenate the assistant CHAT text from a captured FlowData turn. */
function extractAssistantText(items: readonly FlowData[]): string {
  const parts: string[] = [];
  for (const fd of items) {
    if (fd.elementType !== FlowElementTypes.CHAT) continue;
    if (fd.attributes['role'] !== 'assistant') continue;
    const value = fd.content;
    if (typeof value === 'string' && value) parts.push(value);
  }
  return parts.join('\n\n').trim();
}

/** Subscribe to a process's stream, run `trigger`, return FlowData captured
 * up to the next terminal worker status. Subscribes before triggering so the
 * reuse case (worker_status already COMPLETE from a prior turn) sees the new
 * turn's flow_data events before any state_change fires. */
async function captureTurn(
  process: AgenticProcess,
  trigger: () => Promise<unknown>,
): Promise<readonly FlowData[]> {
  const captured: FlowData[] = [];
  let turnStarted = false;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((r) => { resolveDone = r; });

  const dataHandler = (fd: FlowData) => {
    captured.push(fd);
    turnStarted = true;
  };
  const stateHandler = () => {
    if (process.status === ProcessStatus.FAILED) {
      resolveDone?.();
      return;
    }
    // Only treat terminal worker status as "turn done" once we've actually
    // seen output from this turn — guards against the reuse case where the
    // prior turn left workerStatus already at COMPLETE.
    if (turnStarted && isWorkerTerminal(process.workerStatus)) {
      resolveDone?.();
    }
  };

  const unsubData = process.on('flow_data', dataHandler);
  const unsubState = process.on('state_change', stateHandler);

  try {
    await trigger();
    await done;
  } finally {
    unsubData();
    unsubState();
  }
  return captured;
}

/**
 * Single Approve & Execute flow for both task-bound and hub-direct conversations.
 *
 * First click: spawn a `visible=false` AgenticProcess keyed via `target_vfs_path`
 * to the conversation (or task) so the Runs panel picks it up. The headless
 * worker runs the merged prompt. When the worker reaches a terminal status the
 * Runs panel's terminal icon becomes clickable; clicking it promotes the AP
 * to visible (standard `process.start({ visible: true })`).
 *
 * Subsequent click on the same conversation: reuse the same AP. If it was
 * promoted to visible (`shell_id` set), `exit()` the PTY; then set
 * `visible=false` and call `executeInstruction(prompt)` which routes through
 * print mode in the existing entity.
 *
 * In both branches the assistant's reply is captured from the FlowData stream,
 * wrapped client-side as `Prompt response: "…"` (so `MessageBubble` italicises
 * the quoted middle), and persisted as a draft FlowMessage via the unified
 * `append-conversation` action with `is_draft=true`. The draft surfaces in
 * `ConversationView` for the user to edit and send (and to optionally attach
 * files / a PROMPT chip before sending).
 */
/** Mirror of `MessageBubble.parseClaudeQuote`'s unescape (`\"` → `"`, `\\` → `\`).
 *  Escape order is the inverse: `\` first, then `"`. Keep in sync with that file. */
function wrapAsPromptResponse(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `Prompt response: "${escaped}"`;
}
export function useApproveAndExecute(
  { task, conversationId }: UseApproveAndExecuteOptions,
): UseApproveAndExecuteResult {
  const useTaskScope = !!task.id;
  const targetVfsPath = conversationId
    ? new TypeId('conversation', conversationId).toString()
    : '';

  const { data: conversation } = useEntity<Conversation>(
    conversationId ? new TypeId(Conversation.type, conversationId) : null,
  );

  const { processes } = useProcessesForTarget(targetVfsPath, { enabled: !!targetVfsPath });

  const approveAndExecute = async (messageId: string, attachmentIndex: number) => {
    if (!messageId || !targetVfsPath) return;

    let workdir: string | undefined;
    if (useTaskScope) {
      workdir = task.project_root ?? undefined;
    } else if (conversation?.project_id) {
      const project = await dataManager
        .getByTypeId(new TypeId('project', conversation.project_id))
        .catch(() => null);
      workdir = (project as { fs_storage_mount_path?: string } | null)?.fs_storage_mount_path
        ?? undefined;
    }
    if (!workdir) {
      toast.warning('Map this conversation to a local project first.');
      return;
    }

    const flowMessage = await approveAndReload(messageId, attachmentIndex);
    if (!flowMessage) return;

    const promptText = await buildMergedPrompt(flowMessage);
    if (!promptText) {
      toast.error('Prompt is empty — nothing to execute.');
      return;
    }

    // Reuse the most-recent non-failed AP for this target; else spawn fresh.
    const reusable = processes
      .filter((p) => p.status !== ProcessStatus.FAILED)
      .sort((a, b) => {
        const at = a.created_date ? new Date(a.created_date as unknown as string).getTime() : 0;
        const bt = b.created_date ? new Date(b.created_date as unknown as string).getTime() : 0;
        return bt - at;
      })[0];

    let runProcess: AgenticProcess;
    let captured: readonly FlowData[];

    try {
      if (reusable) {
        // Re-fetch live — the React-query snapshot can be stale across approves.
        const live = await dataManager
          .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, reusable.id))
          .catch(() => null);
        runProcess = live ?? reusable;
        if (runProcess.shell_id) {
          await runProcess.exit();
        }
        if (runProcess.visible !== false) {
          runProcess.visible = false;
          await runProcess.save();
        }
        captured = await captureTurn(runProcess, () =>
          runProcess.executeInstruction(promptText, { sync: false }),
        );
      } else {
        // Fresh spawn. For task-bound A&E, fork from ``task.my_process_id``'s
        // Claude session so the headless run inherits the original
        // conversation's transcript — the receiver's prompt should be
        // answered in the context of the prior messages, not from a blank
        // session. Hub-direct conversations have no my_process_id; they
        // spawn fresh.
        let forkSessionId: string | undefined;
        if (useTaskScope && task.my_process_id) {
          const myProcess = await dataManager
            .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, task.my_process_id))
            .catch(() => null);
          if (myProcess?.session_id) {
            forkSessionId = myProcess.session_id;
          }
        }
        // Stamp ``target_vfs_path`` in the same save so the Runs-panel's live
        // entity query matches on first sight.
        const spawned = await AgenticProcess.spawn(
          forkSessionId
            ? { workdir, targetVfsPath, resumeSessionId: forkSessionId, forkSession: true }
            : { workdir, targetVfsPath },
          { headless: true, visible: false },
        );
        runProcess = spawned.process;
        captured = await captureTurn(runProcess, () =>
          runProcess.executeInstruction(promptText, { sync: false }),
        );
      }
    } catch (err) {
      console.error('[approveAndExecute] failed', err);
      toast.error('Failed to run Approve & Execute.');
      return;
    }

    const text = extractAssistantText(captured);
    if (!text || !conversationId) return;

    try {
      const action = new ActionInfo('add_message', 'conversation', conversationId, 'POST');
      action.bodyParameters = {
        message: wrapAsPromptResponse(text),
        is_draft: 'true',
      };
      await dataManager.callAction(action);
    } catch (err) {
      console.error('[approveAndExecute] saving draft failed', err);
    }
  };

  return { approveAndExecute };
}
