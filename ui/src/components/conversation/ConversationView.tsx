import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { AgenticProcess, Conversation, dataContext, dataManager, FlowMessage, Spec, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';

interface ConversationViewProps {
  conversationId: string;
  task: ITask;
  senderName?: string;
}

export function ConversationView({ conversationId, task, senderName }: ConversationViewProps) {
  const { navigation } = useDockNavigation();
  const [lastExecutedCount, setLastExecutedCount] = useState(-1);
  const [executing, setExecuting] = useState(false);

  const { data: conversation, refetch } = useEntity<Conversation>(
    new TypeId(Conversation.type, conversationId),
  );
  const { data: spec } = useEntity<Spec>(
    task.spec_id ? new TypeId(Spec.type, task.spec_id) : null,
    { query: new ExpansionRequest({ expand: ['blobs'] }) },
  );

  const pointers = conversation?.conversationMessageIds ?? [];
  const hasExecuted = lastExecutedCount >= 0;
  const hasDelta = pointers.length > lastExecutedCount;

  const handleExecute = async () => {
    if (executing) return;
    setExecuting(true);
    try {
      const isFirstRun = lastExecutedCount < 0;
      const deltaPointers = isFirstRun ? pointers : pointers.slice(lastExecutedCount);

      // Fetch FlowMessage entities for the relevant range
      const messages = await Promise.all(
        deltaPointers.map((ptr) =>
          dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.message_id)),
        ),
      );

      // Format messages as labeled turns
      const formatMsg = (fm: FlowMessage | null) => {
        if (!fm) return null;
        const isSender = fm.sender_id && task.shared_by_id && fm.sender_id === task.shared_by_id;
        const label = isSender ? (senderName ?? fm.sender_name ?? 'Sender') : 'You';
        return `[${label}]: ${fm.text ?? ''}`;
      };

      // Collect file attachments
      const fileLines = messages
        .flatMap((fm) => fm?.attachment ?? [])
        .filter((a) => a.attachment_type === AttachmentType.FILE)
        .map((a) => `- ${a.data.split('/').pop() ?? a.data} (path: ${a.data})`);

      let prompt: string;
      if (isFirstRun) {
        const specTitle = spec?.title ?? task.title ?? 'Untitled';
        const specContent = spec?.content ?? '';
        const senderLabel = senderName ?? 'Sender';
        const msgLines = messages.map(formatMsg).filter(Boolean).join('\n');
        const parts = [
          `You received a task from ${senderLabel}: "${specTitle}"`,
          '',
          specContent ? `Here is the plan:\n\n${specContent}` : `Task: ${task.title || 'Untitled'}`,
        ];
        if (msgLines) {
          parts.push('', 'Conversation so far:', msgLines);
        }
        if (fileLines.length > 0) {
          parts.push('', 'File attachments:', ...fileLines);
        }
        parts.push('', 'Please read through the plan and conversation carefully and implement the required changes. If anything is unclear, ask before proceeding.');
        prompt = parts.join('\n');
      } else {
        const msgLines = messages.map(formatMsg).filter(Boolean).join('\n');
        const parts = ['New updates since last execution:'];
        if (msgLines) parts.push('', msgLines);
        if (fileLines.length > 0) parts.push('', 'New file attachments:', ...fileLines);
        parts.push('', 'Please continue based on these updates.');
        prompt = parts.join('\n');
      }

      const workdir =
        (task.metadata as Record<string, unknown> | undefined)?.project_root as string | undefined
        ?? dataContext.project?.fs_storage_mount_path;

      const { process: agenticProcess } = await AgenticProcess.spawn(
        { workdir },
        { instruction: prompt, visible: true },
      );
      navigation.openDock(agenticProcess.dockPointer);
      setLastExecutedCount(pointers.length);
    } catch (err) {
      console.error('[Execute with Claude Code] Failed:', err);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="space-y-3">
      {pointers.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/60">No messages yet.</p>
      ) : (
        <div className="space-y-2">
          {pointers.map((ptr) => (
            <FlowMessageBubble
              key={ptr.message_id}
              messageId={ptr.message_id}
              timestamp={ptr.timestamp}
              task={task}
            />
          ))}
        </div>
      )}

      {/* Execute button — shown only for shared tasks (spec_id present) */}
      {task.spec_id && (
        <button
          onClick={() => void handleExecute()}
          disabled={executing || (hasExecuted && !hasDelta)}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4" />
          {executing
            ? 'Starting…'
            : hasExecuted
              ? 'Continue Execution with Claude Code'
              : 'Execute the task with Claude Code'}
        </button>
      )}

      <MessageComposer task={task} onSent={() => void refetch()} />
    </div>
  );
}
