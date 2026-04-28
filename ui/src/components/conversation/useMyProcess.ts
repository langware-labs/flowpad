import { useState } from 'react';
import {
  AgenticProcess,
  Conversation,
  dataContext,
  dataManager,
  FlowMessage,
  ProcessStatus,
  Spec,
  Task,
  TypeId,
} from '@sdk';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useLocalUser } from './useLocalUser';

interface UseMyProcessOptions {
  task: ITask;
  conversationId: string;
  senderName?: string;
}

interface UseMyProcessResult {
  /** Stored on task.metadata.my_process_id; presence flips the chip label. */
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
 */
async function buildReceiverContextPrompt(
  task: ITask,
  conversationId: string,
  senderName: string | undefined,
): Promise<string> {
  const conv = await dataManager.getByTypeId<Conversation>(new TypeId(Conversation.type, conversationId));
  const pointers = conv?.conversationMessageIds ?? [];

  const messages = await Promise.all(
    pointers.map((ptr) =>
      dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.message_id)),
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

  const spec = task.spec_id
    ? await dataManager.getByTypeId<Spec>(
        new TypeId(Spec.type, task.spec_id),
        new ExpansionRequest({ expand: ['blobs'] }),
      ).catch(() => null)
    : null;

  const taskMeta = (task.metadata as Record<string, unknown> | undefined) ?? {};
  const effectiveSpecType = (taskMeta.spec_type as string | undefined) ?? spec?.spec_type ?? 'plan';
  const isSession = effectiveSpecType === 'session';

  const specTitle = spec?.title ?? task.title ?? 'Untitled';
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
    parts.push(`Task: ${task.title || 'Untitled'}`);
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

  parts.push(
    '',
    isSession
      ? 'We are about to assist a user who encountered the following issue. Please read through the above session and conversation carefully and acknowledge you have everything you need.'
      : 'Please read through the above plan and conversation carefully and implement the required changes. If anything is unclear, ask before proceeding.',
  );
  return parts.join('\n');
}

export function useMyProcess({ task, conversationId, senderName }: UseMyProcessOptions): UseMyProcessResult {
  const { navigation } = useDockNavigation();
  const { localUser } = useLocalUser();
  const [busy, setBusy] = useState(false);

  const taskId = task.id ?? '';
  const taskMeta = (task.metadata as Record<string, unknown> | undefined) ?? {};
  const myProcessId = taskMeta.my_process_id as string | undefined;
  const isInitiator = !!(localUser?.id && task.shared_by_id && task.shared_by_id === localUser.id);
  const workdir = (taskMeta.project_root as string | undefined) ?? dataContext.project?.fs_storage_mount_path;

  const isStartLabel = !myProcessId;

  const openOrStart = async () => {
    if (busy || !taskId) return;
    setBusy(true);
    try {
      // Open path: process already exists for this task. Reattach if dead, then navigate.
      if (myProcessId) {
        const existing = await dataManager.getByTypeId<AgenticProcess>(
          new TypeId(AgenticProcess.type, myProcessId),
        ).catch(() => null);
        if (existing) {
          const isAlive = existing.status !== ProcessStatus.STOPPED
            && existing.status !== ProcessStatus.FAILED
            && existing.status !== ProcessStatus.STOPPING;
          if (!isAlive && existing.session_id) {
            // Resume into a fresh worker without injecting any new instruction.
            const { process: resumed } = await AgenticProcess.spawn(
              { workdir, resumeSessionId: existing.session_id },
              { visible: true },
            );
            const t = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
            if (t) {
              t.metadata = { ...(t.metadata ?? {}), my_process_id: resumed.id };
              await t.save();
            }
            navigation.openInBrowserTab(resumed.dockPointer);
            return;
          }
          navigation.openInBrowserTab(existing.dockPointer);
          return;
        }
      }

      // Start path: spawn a brand-new process. Recipient gets the conversation
      // context injected as the first instruction; initiator starts clean.
      const instruction = isInitiator
        ? undefined
        : await buildReceiverContextPrompt(task, conversationId, senderName);
      const { process: spawned } = await AgenticProcess.spawn(
        { workdir },
        { instruction, visible: true },
      );
      const t = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
      if (t) {
        t.metadata = { ...(t.metadata ?? {}), my_process_id: spawned.id };
        await t.save();
      }
      navigation.openInBrowserTab(spawned.dockPointer);
    } catch (err) {
      console.error('[useMyProcess] openOrStart failed:', err);
    } finally {
      setBusy(false);
    }
  };

  return { myProcessId, isStartLabel, busy, openOrStart };
}
