import { useCallback, useState } from 'react';
import { Download, ListTodo, Loader2 } from 'lucide-react';
import { AgenticProcess, Task } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { useFlowpadAssistantProject } from '@src/components/floating-chat/useFlowpadAssistantProject';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { notify } from '@src/notifications';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey } from './keys';

interface MessageChipsProps {
  flowMessageId?: string;
  /** Parent conversation id — needed to seed the assistant launch prompt. When
   *  omitted the launch buttons are hidden (download still renders). */
  conversationId?: string;
  /** Message body — its first 10 words become the favorite / task title. */
  messageText?: string;
}

type WorkerType = 'claude_code' | 'codex';

interface Harness {
  workerType: WorkerType;
  name: string;
  Icon: typeof ClaudeIcon;
  iconClassName?: string;
}

const HARNESSES: Harness[] = [
  { workerType: 'claude_code', name: 'claude', Icon: ClaudeIcon, iconClassName: 'text-orange-500' },
  { workerType: 'codex', name: 'codex', Icon: CodexIcon },
];

function localDownloadUrl(messageId: string): string {
  return new ActionInfo('create-and-download-local-flowmsg', 'flow_message', messageId, 'GET').fullActionUrl;
}

/** First `n` whitespace-delimited words of `text`, trimmed. Empty when no text. */
function firstWords(text: string | undefined, n: number): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  return t.split(/\s+/).slice(0, n).join(' ');
}

/**
 * Per-message chip row. Left group: download + launch toolbar (Claude / Codex)
 * that spawns an AgenticProcess in the ``@flowpad_assistant`` project pre-seeded
 * with a "load this message" prompt. Right group (``ml-auto``): favorite star +
 * create-task, both titled from the message's first 10 words.
 *
 * Anything already rendered by a higher-level chip row (Task or Conversation)
 * is suppressed via ``ChipsExcludeContext``.
 */
export function MessageChips({ flowMessageId, conversationId, messageText }: MessageChipsProps) {
  const exclude = useChipsExclude();
  const { project: assistantProject } = useFlowpadAssistantProject();
  const { navigation } = useDockNavigation();
  const [pending, setPending] = useState<WorkerType | null>(null);
  const [taskPending, setTaskPending] = useState(false);

  const title = firstWords(messageText, 10) || `Message ${flowMessageId?.slice(0, 8) ?? ''}`.trim();

  const handleLaunch = useCallback(
    async (workerType: WorkerType) => {
      if (pending || !flowMessageId || !conversationId) return;
      setPending(workerType);
      try {
        const prompt =
          `Use the flowpad-assistance skill and load conversation ${conversationId}, ` +
          `message: ${flowMessageId}`;
        await AgenticProcess.openTab(workerType, prompt, assistantProject);
      } catch (err) {
        console.error('[MessageChips] launch failed', err);
      } finally {
        setPending(null);
      }
    },
    [pending, flowMessageId, conversationId, assistantProject],
  );

  const handleCreateTask = useCallback(async () => {
    if (taskPending) return;
    setTaskPending(true);
    try {
      const task = await Task.createInProject(null, title);
      notify.success({ title: 'Task created', message: title });
      navigation.openDock(DockPointer.forTasks(task.id));
    } catch (err) {
      console.error('[MessageChips] create task failed', err);
      notify.error({ title: 'Failed to create task' });
    } finally {
      setTaskPending(false);
    }
  }, [taskPending, title, navigation]);

  if (!flowMessageId) return null;
  const showDownload = !exclude.has(ChipKey.download(flowMessageId));

  return (
    <>
      <span className="ml-1 flex items-center gap-0.5">
        {showDownload && (
          <a
            href={localDownloadUrl(flowMessageId)}
            download
            title="Download message"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
          >
            <Download className="h-3 w-3" />
          </a>
        )}
        {conversationId &&
          HARNESSES.map(({ workerType, name, Icon, iconClassName }) => {
            const isPending = pending === workerType;
            return (
              <button
                key={workerType}
                type="button"
                onClick={() => void handleLaunch(workerType)}
                disabled={pending !== null}
                title={`Open this message in ${name}`}
                aria-label={`Open this message in ${name}`}
                data-testid={`message-launch-${name}`}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100 disabled:cursor-not-allowed"
              >
                {isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Icon className={`h-3 w-3 ${iconClassName ?? ''}`} />
                )}
              </button>
            );
          })}
      </span>
      <span className="ml-auto flex items-center gap-0.5">
        <FavoriteStar
          entityType="flow_message"
          entityId={flowMessageId}
          title={title}
          size={13}
          className="h-5 w-5 p-0 opacity-60 transition-opacity hover:opacity-100"
        />
        <button
          type="button"
          onClick={() => void handleCreateTask()}
          disabled={taskPending}
          title="Create task from this message"
          aria-label="Create task from this message"
          data-testid="message-create-task"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100 disabled:cursor-not-allowed"
        >
          {taskPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ListTodo className="h-3 w-3" />
          )}
        </button>
      </span>
    </>
  );
}
