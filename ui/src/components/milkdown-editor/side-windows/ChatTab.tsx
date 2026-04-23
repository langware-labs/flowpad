import { EntityChatPanel } from '@src/components/entity-chat-panel';
import type { AgenticProcess } from '@sdk';

interface ChatTabProps {
  /** Serialized attachment key (e.g. `markdown_file-<path>`). */
  target: string | null;
  /** Optional hook run once after the backing process is created. */
  onProcessCreated?: (process: AgenticProcess) => Promise<void> | void;
}

export function ChatTab({ target, onProcessCreated }: ChatTabProps) {
  return <EntityChatPanel target={target} onProcessCreated={onProcessCreated} className="h-full" />;
}
