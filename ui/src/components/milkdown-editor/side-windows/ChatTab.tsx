import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { ProcessKind, type AgenticProcess } from '@sdk';

interface ChatTabProps {
  /** Serialized entity TypeId (e.g. `"plan-<uuid>"`). Null → chat disabled. */
  target: string | null;
  /** Optional hook run once after the backing process is created. */
  onChatProcessCreated?: (process: AgenticProcess) => Promise<void> | void;
  /** Caret line (1-indexed, on-disk) — rendered as "line N" in the chat header. */
  cursorLine?: number | null;
}

export function ChatTab({ target, onChatProcessCreated, cursorLine }: ChatTabProps) {
  return (
    <EntityExecutionPanel
      target={target}
      processType={ProcessKind.Chat}
      onProcessCreated={onChatProcessCreated}
      cursorLine={cursorLine}
      className="h-full"
    />
  );
}
