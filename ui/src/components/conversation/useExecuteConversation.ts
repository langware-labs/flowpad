import type { ITask } from '@sdk/entities/task';
import { useMyProcess } from './useMyProcess';

interface UseExecuteConversationOptions {
  task: ITask;
  conversationId: string;
  senderName?: string;
  onAfterExecute?: () => void;
}

interface UseExecuteConversationResult {
  /** Stored on task.metadata.my_process_id; presence flips the chip label between Start / Open. */
  myProcessId: string | undefined;
  /** True until the user has started a Claude Code session for this conversation. */
  isStartLabel: boolean;
  /** True while a spawn / resume is in flight. */
  executing: boolean;
  /** Spawn a new process (Start) or open the existing one (Open) in the secondary browser tab. */
  execute: () => Promise<void>;
}

/**
 * Thin delegate around `useMyProcess`. The chip-level Start / Open behavior
 * lives entirely in that hook — this wrapper exists so existing call sites
 * keep using `execute()` without churn.
 */
export function useExecuteConversation({
  task,
  conversationId,
  senderName,
  onAfterExecute,
}: UseExecuteConversationOptions): UseExecuteConversationResult {
  const { myProcessId, isStartLabel, busy, openOrStart } = useMyProcess({
    task,
    conversationId,
    senderName,
  });

  const execute = async () => {
    await openOrStart();
    onAfterExecute?.();
  };

  return { myProcessId, isStartLabel, executing: busy, execute };
}
