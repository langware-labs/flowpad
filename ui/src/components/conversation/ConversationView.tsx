import { useState } from 'react';
import { FolderOpen, Sparkles } from 'lucide-react';
import { AgenticProcess, Conversation, dataContext, dataManager, FlowMessage, ProcessStatus, Spec, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';

/** Module-level cache: task_id → AgenticProcess. Survives component remounts within a session. */
const taskSessionCache = new Map<string, AgenticProcess>();

interface ConversationViewProps {
  conversationId: string;
  task: ITask;
  senderName?: string;
  onChooseProject?: () => void;
}

export function ConversationView({ conversationId, task, senderName, onChooseProject }: ConversationViewProps) {
  const { navigation } = useDockNavigation();
  const taskId = task.id ?? '';
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
  const taskMeta = (task.metadata as Record<string, unknown> | undefined) ?? {};
  const storedSessionId = taskMeta.agentic_session_id as string | undefined;
  const storedWorkdir = taskMeta.agentic_workdir as string | undefined;
  const storedProcessId = taskMeta.agentic_process_id as string | undefined;
  const storedExecutedCount = (taskMeta.agentic_executed_count as number | undefined) ?? -1;
  // Effective cursor: use local state if already set this session, otherwise fall back to DB value
  const effectiveExecutedCount = lastExecutedCount >= 0 ? lastExecutedCount : storedExecutedCount;
  const hasExecuted = effectiveExecutedCount >= 0 || taskSessionCache.has(taskId) || !!storedSessionId;
  const hasDelta = pointers.length > effectiveExecutedCount;

  const handleExecute = async () => {
    if (executing) return;
    setExecuting(true);
    try {
      const isFirstRun = effectiveExecutedCount < 0 && !taskSessionCache.has(taskId) && !storedSessionId;
      const deltaPointers = isFirstRun ? pointers : pointers.slice(effectiveExecutedCount);

      // Fetch FlowMessage entities for the relevant range
      const messages = await Promise.all(
        deltaPointers.map((ptr) =>
          dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.message_id)),
        ),
      );

      // Format messages as labeled turns — use sender_name from the message, fall back to senderName prop
      const formatMsg = (fm: FlowMessage | null) => {
        if (!fm) return null;
        const isSender = fm.sender_id && task.shared_by_id && fm.sender_id === task.shared_by_id;
        const label = isSender
          ? (fm.sender_name || senderName || 'Sender')
          : (fm.sender_name || 'You');
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
        const closingInstruction = spec?.spec_type === 'session'
          ? 'Please read through the above session and conversation carefully and assist the user with the issue he encountered. If anything is unclear, ask before proceeding.'
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

      const workdir = taskMeta.project_root as string | undefined
        ?? dataContext.project?.fs_storage_mount_path;

      // ── Session routing ────────────────────────────────────────────────
      // Priority: in-memory cache → reconnect live process → resume dead session → first spawn
      const cached = taskSessionCache.get(taskId);
      if (cached) {
        // PTY client still live in this browser session — send directly
        await cached.executeInstruction(prompt, { sync: false });
        navigation.openDock(cached.dockPointer);
      } else if (storedProcessId) {
        // Page was refreshed — try to reconnect to the existing process
        const existingProcess = await dataManager.getByTypeId<AgenticProcess>(
          new TypeId(AgenticProcess.type, storedProcessId),
        ).catch(() => null);

        const isAlive = existingProcess &&
          existingProcess.status !== ProcessStatus.STOPPED &&
          existingProcess.status !== ProcessStatus.FAILED &&
          existingProcess.status !== ProcessStatus.STOPPING;

        if (isAlive) {
          // Process is still running — reconnect PTY and deliver instruction via start()
          // (avoids the stale workerStatus check in executeInstruction after a page refresh)
          await existingProcess!.start({ instruction: prompt });
          taskSessionCache.set(taskId, existingProcess!);
          navigation.openDock(existingProcess!.dockPointer);
        } else {
          // Process is dead — close it, spawn a resumed session with the same Claude session_id
          if (existingProcess) await existingProcess.close().catch(() => {});
          const { process: resumed } = await AgenticProcess.spawn(
            { workdir: storedWorkdir ?? workdir, resumeSessionId: storedSessionId },
            { instruction: prompt, visible: true },
          );
          taskSessionCache.set(taskId, resumed);
          navigation.openDock(resumed.dockPointer);
          const tResume = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
          if (tResume) {
            tResume.metadata = { ...(tResume.metadata ?? {}), agentic_process_id: resumed.id };
            await tResume.save();
          }
        }
      } else if (storedSessionId) {
        // Legacy: session_id stored but process_id not tracked — resume fresh
        const { process: resumed } = await AgenticProcess.spawn(
          { workdir: storedWorkdir ?? workdir, resumeSessionId: storedSessionId },
          { instruction: prompt, visible: true },
        );
        taskSessionCache.set(taskId, resumed);
        navigation.openDock(resumed.dockPointer);
        const tLegacy = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
        if (tLegacy) {
          tLegacy.metadata = { ...(tLegacy.metadata ?? {}), agentic_process_id: resumed.id };
          await tLegacy.save();
        }
      } else {
        // First run — spawn a brand-new session
        const { process: agenticProcess } = await AgenticProcess.spawn(
          { workdir },
          { instruction: prompt, visible: true },
        );
        taskSessionCache.set(taskId, agenticProcess);
        navigation.openDock(agenticProcess.dockPointer);
        // Persist session_id, workdir, and process_id — all needed for reliable resume
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

      // Persist the cursor so delta is correct after restart
      const liveTask = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
      if (liveTask) {
        liveTask.metadata = { ...(liveTask.metadata ?? {}), agentic_executed_count: pointers.length };
        await liveTask.save();
      }
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

      {/* Execute + Choose Project buttons */}
      {task.spec_id && (
        <div className="flex gap-1">
          <button
            onClick={() => void handleExecute()}
            disabled={executing}
            className="flex flex-[19] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            {executing
              ? 'Starting…'
              : hasExecuted
                ? 'Continue Execution with Claude Code'
                : 'Execute the task with Claude Code'}
          </button>
          {onChooseProject && (
            <button
              onClick={onChooseProject}
              title="Choose project folder"
              className="flex flex-[4] items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              Choose Project
            </button>
          )}
        </div>
      )}

      <MessageComposer task={task} onSent={() => void refetch()} />
    </div>
  );
}
