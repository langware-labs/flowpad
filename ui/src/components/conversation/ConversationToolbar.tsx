import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { Conversation, dataManager, FlowMessage, TypeId } from '@sdk';
import { AttachmentType } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import type { ITask } from '@sdk/entities/task';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useMyProcess } from './useMyProcess';

interface TranscriptInfo {
  messageId: string;
  vfsPath: string;
}

function fileAttachmentUrl(messageId: string, vfsPath: string): string {
  const action = new ActionInfo('fs', 'flow_message', messageId, 'GET');
  action.subpath = `download/${vfsPath}`;
  return action.fullActionUrl;
}

interface ConversationToolbarProps {
  task: ITask;
  conversationId: string;
  senderName?: string;
  onShowTask: () => void;
}

/**
 * Sits next to the "Conversation" header. Hosts the per-conversation actions
 * (Open Task, Transcript File, Claude Code) that used to live as per-message
 * chips. Stays out of MessageActionChips so each bubble doesn't duplicate them.
 */
export function ConversationToolbar({
  task,
  conversationId,
  senderName,
  onShowTask,
}: ConversationToolbarProps) {
  const [transcript, setTranscript] = useState<TranscriptInfo | null>(null);
  const { isStartLabel, busy, openOrStart } = useMyProcess({ task, conversationId, senderName });

  // Find the first conversation.jsonl FILE attachment across all messages.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conv = await dataManager.getByTypeId<Conversation>(
          new TypeId(Conversation.type, conversationId),
        );
        const pointers = conv?.conversationMessageIds ?? [];
        for (const ptr of pointers) {
          const fm = await dataManager
            .getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.message_id))
            .catch(() => null);
          if (!fm) continue;
          const att = (fm.attachment ?? []).find(
            (a) => a.attachment_type === AttachmentType.FILE && a.data.endsWith('conversation.jsonl'),
          );
          if (att) {
            if (!cancelled) setTranscript({ messageId: ptr.message_id, vfsPath: att.data });
            return;
          }
        }
        if (!cancelled) setTranscript(null);
      } catch {
        if (!cancelled) setTranscript(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const showOpenTask = !!task.spec_id;
  const claudeTooltip = isStartLabel ? 'Start Claude Code session' : 'Open Claude Code';

  return (
    <div className="flex items-center gap-1">
      {showOpenTask && (
        <button
          type="button"
          onClick={onShowTask}
          className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FileText className="h-3 w-3" />
          Open Task
        </button>
      )}

      {transcript && (
        <a
          href={fileAttachmentUrl(transcript.messageId, transcript.vfsPath)}
          target="_blank"
          rel="noreferrer"
          download
          title="Download sender's Claude Code transcript"
          className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FileText className="h-3 w-3" />
          Transcript File
        </a>
      )}

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void openOrStart()}
              disabled={busy}
              aria-label={claudeTooltip}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-orange-500 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
            >
              <ClaudeIcon className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            {busy ? 'Starting…' : claudeTooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
