import { useState } from 'react';
import { AgenticProcess, Conversation, dataContext, dataManager, FlowMessage, ProcessStatus, Spec, Task, TypeId } from '@sdk';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** task_id → live AgenticProcess for the original (non-fork) Claude session. */
const taskSessionCache = new Map<string, AgenticProcess>();

interface UseExecuteConversationOptions {
  task: ITask;
  conversationId: string;
  senderName?: string;
  onAfterExecute?: () => void;
}

interface UseExecuteConversationResult {
  executing: boolean;
  /** Execute everything up to and including `uptoMessageId` (or the whole conversation when omitted). */
  execute: (uptoMessageId?: string) => Promise<void>;
}

export function useExecuteConversation({
  task,
  conversationId,
  senderName,
  onAfterExecute,
}: UseExecuteConversationOptions): UseExecuteConversationResult {
  const { navigation } = useDockNavigation();
  const [executing, setExecuting] = useState(false);

  const taskId = task.id ?? '';

  const execute = async (uptoMessageId?: string) => {
    if (executing || !taskId) return;
    setExecuting(true);
    try {
      const conv = await dataManager.getByTypeId<Conversation>(new TypeId(Conversation.type, conversationId));
      if (!conv) return;
      const allPointers = conv.conversationMessageIds ?? [];

      const taskMeta = (task.metadata as Record<string, unknown> | undefined) ?? {};
      const storedSessionId = taskMeta.agentic_session_id as string | undefined;
      const storedWorkdir = taskMeta.agentic_workdir as string | undefined;
      const storedProcessId = taskMeta.agentic_process_id as string | undefined;
      const storedExecutedCount = (taskMeta.agentic_executed_count as number | undefined) ?? -1;

      const upToIdx = uptoMessageId
        ? Math.max(0, allPointers.findIndex((p) => p.message_id === uptoMessageId)) + 1
        : allPointers.length;
      const pointers = allPointers.slice(0, upToIdx);

      const isFirstRun = storedExecutedCount < 0 && !taskSessionCache.has(taskId) && !storedSessionId;
      const deltaPointers = isFirstRun ? pointers : pointers.slice(storedExecutedCount);

      const messages = await Promise.all(
        deltaPointers.map((ptr) =>
          dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.message_id)),
        ),
      );

      const formatMsg = (fm: FlowMessage | null) => {
        if (!fm) return null;
        const isSender = fm.sender_id && task.shared_by_id && fm.sender_id === task.shared_by_id;
        const label = isSender ? (fm.sender_name || senderName || 'Sender') : (fm.sender_name || 'You');
        return `[${label}]: ${fm.text ?? ''}`;
      };

      const fileLines = messages
        .flatMap((fm) => fm?.attachment ?? [])
        .filter((a) => a.attachment_type === AttachmentType.FILE)
        .map((a) => {
          const absPath = a.local_path ?? a.data;
          const filename = a.data.split('/').pop() ?? a.data;
          return `- ${filename} (path: ${absPath})`;
        });

      let prompt: string;
      const spec = task.spec_id
        ? await dataManager.getByTypeId<Spec>(new TypeId(Spec.type, task.spec_id), {
            query: new ExpansionRequest({ expand: ['blobs'] }),
          }).catch(() => null)
        : null;
      // Prefer spec_type from task metadata (stamped at send/receive time) over the
      // loaded Spec entity, since the Spec may not yet be materialized on this side.
      const effectiveSpecType = (taskMeta.spec_type as string | undefined) ?? spec?.spec_type ?? 'plan';
      if (isFirstRun) {
        const specTitle = spec?.title ?? task.title ?? 'Untitled';
        const specContent = spec?.content ?? '';
        const senderLabel = senderName ?? 'Sender';
        const msgLines = messages.map(formatMsg).filter(Boolean).join('\n');
        const intro = effectiveSpecType === 'session'
          ? `Below is a session and conversation that ${senderLabel} sent for assistance: "${specTitle}"`
          : `You received a task from ${senderLabel}: "${specTitle}"`;
        const parts = [intro, ''];
        if (specContent) {
          parts.push(effectiveSpecType === 'session' ? `Session content:\n\n${specContent}` : `Here is the plan:\n\n${specContent}`);
        } else {
          parts.push(`Task: ${task.title || 'Untitled'}`);
        }
        if (msgLines) parts.push('', 'Conversation so far:', msgLines);
        if (fileLines.length > 0) parts.push('', 'File attachments:', ...fileLines);
        const closingInstruction = effectiveSpecType === 'session'
          ? 'We are about to assist a user who encountered the following issue. Please read through the above session and conversation carefully and acknowledge you have everything you need. Then specify the conversation.json path that we attached, the conversation between the 2 users (like we have now), and a list of the rest of the attachments.'
          : 'Please read through the plan and conversation carefully and implement the required changes. If anything is unclear, ask before proceeding.';
        parts.push('', closingInstruction);
        prompt = parts.join('\n');
      } else {
        const msgLines = messages.map(formatMsg).filter(Boolean).join('\n');
        const parts = ['New updates since last execution:'];
        if (msgLines) parts.push('', msgLines);
        if (fileLines.length > 0) parts.push('', 'New file attachments:', ...fileLines);
        parts.push('', 'Please continue based on these updates.');
        prompt = parts.join('\n');
      }

      const workdir = (taskMeta.project_root as string | undefined) ?? dataContext.project?.fs_storage_mount_path;

      const cached = taskSessionCache.get(taskId);
      if (cached) {
        await cached.executeInstruction(prompt, { sync: false });
        navigation.openInBrowserTab(cached.dockPointer);
      } else if (storedProcessId) {
        const existingProcess = await dataManager.getByTypeId<AgenticProcess>(
          new TypeId(AgenticProcess.type, storedProcessId),
        ).catch(() => null);

        const isAlive = existingProcess &&
          existingProcess.status !== ProcessStatus.STOPPED &&
          existingProcess.status !== ProcessStatus.FAILED &&
          existingProcess.status !== ProcessStatus.STOPPING;

        if (isAlive) {
          await existingProcess!.start({ instruction: prompt });
          taskSessionCache.set(taskId, existingProcess!);
          navigation.openInBrowserTab(existingProcess!.dockPointer);
        } else {
          if (existingProcess) await existingProcess.close().catch(() => {});
          const { process: resumed } = await AgenticProcess.spawn(
            { workdir: storedWorkdir ?? workdir, resumeSessionId: storedSessionId },
            { instruction: prompt, visible: true },
          );
          taskSessionCache.set(taskId, resumed);
          navigation.openInBrowserTab(resumed.dockPointer);
          const tResume = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
          if (tResume) {
            tResume.metadata = { ...(tResume.metadata ?? {}), agentic_process_id: resumed.id };
            await tResume.save();
          }
        }
      } else if (storedSessionId) {
        const { process: resumed } = await AgenticProcess.spawn(
          { workdir: storedWorkdir ?? workdir, resumeSessionId: storedSessionId },
          { instruction: prompt, visible: true },
        );
        taskSessionCache.set(taskId, resumed);
        navigation.openInBrowserTab(resumed.dockPointer);
        const tLegacy = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
        if (tLegacy) {
          tLegacy.metadata = { ...(tLegacy.metadata ?? {}), agentic_process_id: resumed.id };
          await tLegacy.save();
        }
      } else {
        const { process: agenticProcess } = await AgenticProcess.spawn(
          { workdir },
          { instruction: prompt, visible: true },
        );
        taskSessionCache.set(taskId, agenticProcess);
        navigation.openInBrowserTab(agenticProcess.dockPointer);
        if (agenticProcess.session_id) {
          const t = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
          if (t) {
            t.metadata = {
              ...(t.metadata ?? {}),
              agentic_session_id: agenticProcess.session_id,
              agentic_workdir: workdir,
              agentic_process_id: agenticProcess.id,
            };
            await t.save();
          }
        }
      }

      const liveTask = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
      if (liveTask) {
        liveTask.metadata = { ...(liveTask.metadata ?? {}), agentic_executed_count: pointers.length };
        await liveTask.save();
      }
      onAfterExecute?.();
    } catch (err) {
      console.error('[Execute with Claude Code] Failed:', err);
    } finally {
      setExecuting(false);
    }
  };

  return { executing, execute };
}
