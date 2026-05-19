import { useState } from 'react';
import {
  AgenticProcess,
  Conversation,
  dataManager,
  FlowMessage,
  Spec,
  Task,
  TypeId,
} from '@sdk';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useLocalUser } from './useLocalUser';
import { buildSharedAndPrivateContextSection } from './prompt-building';

interface UseMyProcessOptions {
  task: Task;
  conversationId: string;
  senderName?: string;
}

interface UseMyProcessResult {
  /** Stored on task.my_process_id; presence flips the chip label. */
  myProcessId: string | undefined;
  /** True until the user has started a Claude Code session for this conversation. */
  isStartLabel: boolean;
  /** True while a spawn / resume is in flight. */
  busy: boolean;
  /** Spawn a new process (Start) or open the existing one (Open) in the secondary browser tab. */
  openOrStart: () => Promise<void>;
}

/**
 * Build the receiver's "first Start" instruction — same six-section structured
 * prompt we used to inject every execute. Only fires once: subsequent Opens
 * just reattach to the existing process with no instruction.
 *
 * Exported so the Shared Context "Start session" actions (spec row, transcript
 * row) can spawn an AgenticProcess with the same prompt.
 */
export async function buildReceiverContextPrompt(
  task: Task,
  conversationId: string,
  senderName: string | undefined,
  privateTypeIds: readonly TypeId[] = [],
): Promise<string> {
  const conv = await dataManager.getByTypeId<Conversation>(new TypeId(Conversation.type, conversationId));
  const pointers = conv?.conversationMessageIds ?? [];

  const messages = await Promise.all(
    pointers.map((ptr) =>
      dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.id)),
    ),
  );

  const formatMsg = (fm: FlowMessage | null) => {
    if (!fm) return null;
    const isSender = fm.sender_id && task.shared_by_id && fm.sender_id === task.shared_by_id;
    const label = isSender ? (fm.sender_name || senderName || 'Sender') : (fm.sender_name || 'You');
    return `[${label}]: ${fm.text ?? ''}`;
  };

  const allFiles = messages
    .flatMap((fm) => fm?.attachment ?? [])
    .filter((a) => a.attachment_type === AttachmentType.FILE);
  const transcript = allFiles.find((a) => a.data.endsWith('conversation.jsonl'));
  const otherFileLines = allFiles
    .filter((a) => a !== transcript)
    .map((a) => {
      const absPath = a.local_path ?? a.data;
      const filename = a.data.split('/').pop() ?? a.data;
      return `- ${filename} (path: ${absPath})`;
    });
  const transcriptPath = transcript ? (transcript.local_path ?? transcript.data) : null;

  const specTypeId = task.firstContextOfType('spec');
  const spec = specTypeId
    ? await dataManager.getByTypeId<Spec>(
        specTypeId,
        new ExpansionRequest({ expand: ['blobs'] }),
      ).catch(() => null)
    : null;

  const effectiveSpecType = task.spec_type ?? spec?.spec_type ?? 'plan';
  const isSession = effectiveSpecType === 'session';

  const specTitle = spec?.displayName ?? task.displayName;
  const specContent = spec?.content ?? '';
  const senderLabel = senderName ?? 'Sender';
  const msgLines = messages.map(formatMsg).filter(Boolean).join('\n');

  const parts: string[] = [
    isSession
      ? `Below is a session and conversation that ${senderLabel} sent for assistance: "${specTitle}"`
      : `You received a task from ${senderLabel}: "${specTitle}"`,
    '',
  ];

  if (specContent) {
    parts.push(isSession ? `Session content:\n\n${specContent}` : `Here is the plan:\n\n${specContent}`);
  } else {
    parts.push(`Task: ${task.displayName}`);
  }

  if (transcriptPath) {
    parts.push('', "Sender's Claude Code transcript (conversation.jsonl):", transcriptPath);
  }
  if (msgLines) {
    parts.push('', 'Conversation between the two users:', msgLines);
  }
  if (otherFileLines.length > 0) {
    parts.push('', 'Other attachments:', ...otherFileLines);
  }

  // Local on-disk paths for every Flowpad entity referenced in this
  // conversation, split into Shared (what arrived on the FlowMessages and
  // the Task) and Private (what the local user attached under Private
  // Context). Same `<recordsRoot>/<type>/<type>-@<id>/metadata.json`
  // convention Approve & Execute uses; the shared helper handles dedupe
  // and the recordsRoot fallback.
  const sharedTypeIds = new Map<string, TypeId>();
  const addShared = (t: TypeId | null | undefined) => {
    if (!t) return;
    const key = t.toString();
    if (!sharedTypeIds.has(key)) sharedTypeIds.set(key, t);
  };
  for (const fm of messages) {
    if (!fm) continue;
    for (const t of fm.sharedContextEntities ?? []) addShared(t);
  }
  for (const t of task.sharedContextEntities ?? []) addShared(t);
  // Drop anything that's already in private to avoid duplicates across the
  // two sections — private wins for the local user's view.
  const privateKeys = new Set(privateTypeIds.map((t) => t.toString()));
  for (const k of privateKeys) sharedTypeIds.delete(k);
  const ctxSection = buildSharedAndPrivateContextSection(
    Array.from(sharedTypeIds.values()),
    privateTypeIds,
  );
  if (ctxSection) {
    parts.push('', ctxSection);
  }

  // Closing instruction only fires when an actual Spec is attached — without
  // one there's no "plan" to read or "issue" to triage, so we leave it off
  // and let the user drive the conversation themselves.
  if (spec) {
    parts.push(
      '',
      isSession
        ? 'We are about to assist a user who encountered the following issue. Please read through the above session and conversation carefully and acknowledge you have everything you need.'
        : 'Please read through the above plan and conversation carefully and implement the required changes. If anything is unclear, ask before proceeding.',
    );
  }
  return parts.join('\n');
}

export function useMyProcess({ task, conversationId, senderName }: UseMyProcessOptions): UseMyProcessResult {
  const { navigation } = useDockNavigation();
  const { localUser } = useLocalUser();
  const [busy, setBusy] = useState(false);

  const taskId = task.id ?? '';
  const myProcessId = task.my_process_id ?? undefined;
  const isInitiator = !!(localUser?.id && task.shared_by_id && task.shared_by_id === localUser.id);
  // Workdir must come from the task's own mapped project. We deliberately do
  // NOT fall back to the global active project (`dataContext.project`) — that
  // would pick up whatever the footer happens to have selected, which is the
  // exact mistake the mapping dialog exists to prevent.
  const workdir = task.project_root ?? undefined;

  const isStartLabel = !myProcessId;

  const openOrStart = async () => {
    if (busy || !taskId) return;
    // Hard guard: refuse to spawn / resume without a project. The mapping
    // gate in the parent should have surfaced the dialog before we got here.
    if (!workdir) {
      console.warn('[useMyProcess] openOrStart called without project_root — skipping');
      return;
    }
    setBusy(true);
    try {
      if (myProcessId) {
        const existing = await dataManager.getByTypeId<AgenticProcess>(
          new TypeId(AgenticProcess.type, myProcessId),
        ).catch(() => null);
        // Diagnostic: log when we're about to open an AP whose creator is
        // not the local user. This means the leak is still happening — the
        // ownership check is here only to surface the problem, not to
        // patch around it. Once the leak source is fixed, this branch
        // should never fire. ``created_by`` is a bare UUID (see
        // flow_sdk/db/drivers/db_driver.py), not a `user-<uuid>` typeid.
        if (
          existing
          && !!localUser?.id
          && typeof existing.created_by === 'string'
          && existing.created_by !== localUser.id
        ) {
          console.warn(
            '[useMyProcess] task.my_process_id points at a foreign AgenticProcess. ' +
            'This means a sender-side process id is leaking into a receiver task. ' +
            `task=${taskId} my_process_id=${myProcessId} ` +
            `existing.created_by=${existing.created_by} ` +
            `localUser.id=${localUser.id}`,
          );
        }
        if (existing) {
          await existing.start();
          navigation.openDock(existing.terminalDockPointer);
          return;
        }
      }

      // Start path: spawn a brand-new process. Recipient gets the conversation
      // context injected as the first instruction; initiator starts clean.
      const instruction = isInitiator
        ? undefined
        : await buildReceiverContextPrompt(task, conversationId, senderName);
      const { process: spawned } = await AgenticProcess.spawn(
        { workdir, projectId: task.project_id ?? undefined },
        { instruction, visible: true },
      );
      const t = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
      if (t) {
        t.my_process_id = spawned.id;
        await t.save();
      }
      navigation.openDock(spawned.terminalDockPointer);
    } catch (err) {
      console.error('[useMyProcess] openOrStart failed:', err);
    } finally {
      setBusy(false);
    }
  };

  return { myProcessId, isStartLabel, busy, openOrStart };
}
