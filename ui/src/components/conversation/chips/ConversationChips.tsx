import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { AgenticProcess, dataManager, TypeId } from '@sdk';
import type { ITask } from '@sdk/entities/task';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { fileAttachmentUrl } from '../attachment-url';
import {
  findConversationTranscript,
  type ConversationTranscriptInfo,
} from '../find-conversation-transcript';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey } from './keys';

interface ConversationChipsProps {
  conversationId: string;
  task?: ITask | null;
}

/**
 * Chip row for the Conversation: transcript file link + shared-terminal
 * button (when a prompt has been approved). Anything already shown by the
 * TaskChips row above is suppressed via ``ChipsExcludeContext``.
 */
export function ConversationChips({ conversationId, task }: ConversationChipsProps) {
  const exclude = useChipsExclude();
  const { navigation } = useDockNavigation();
  const [transcript, setTranscript] = useState<ConversationTranscriptInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void findConversationTranscript(conversationId).then((info) => {
      if (!cancelled) setTranscript(info);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const sharedProcessId = task?.shared_process_id ?? undefined;

  const showTranscript = !!transcript && !exclude.has(ChipKey.transcript(transcript.vfsPath));
  const showSharedTerminal =
    !!sharedProcessId && !exclude.has(ChipKey.sharedTerminal(sharedProcessId));

  const handleOpenShared = async () => {
    if (!sharedProcessId) return;
    const proc = await dataManager
      .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, sharedProcessId))
      .catch(() => null);
    if (!proc) return;
    navigation.openInBrowserTab(proc.dockPointer);
  };

  return (
    <>
      {showTranscript && transcript && (
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

      {showSharedTerminal && (
        <button
          type="button"
          onClick={() => void handleOpenShared()}
          title="Open the shared terminal where approved prompts run"
          className="inline-flex h-6 items-center gap-1 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 text-[11px] font-medium text-orange-700 transition-colors hover:bg-orange-500/20 dark:text-orange-300"
        >
          <ClaudeIcon className="h-3 w-3" />
          Open Shared Terminal
        </button>
      )}
    </>
  );
}
