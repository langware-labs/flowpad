import { EntityChatPanel } from '@src/components/entity-chat-panel';
import type { AgenticProcess } from '@sdk';

interface ChatTabProps {
  /** Serialized entity TypeId (e.g. `"plan-<uuid>"`). Null → chat disabled. */
  target: string | null;
  /** Optional hook run once after the backing process is created. */
  onProcessCreated?: (process: AgenticProcess) => Promise<void> | void;
  /** Caret line (1-indexed, on-disk) — rendered as "line N" in the chat header. */
  cursorLine?: number | null;
}

export function ChatTab({ target, onProcessCreated, cursorLine }: ChatTabProps) {
  return (
    <EntityChatPanel
      target={target}
      onProcessCreated={onProcessCreated}
      cursorLine={cursorLine}
      className="h-full"
    />
  );
}
