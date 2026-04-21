import { EntityChatPanel } from '@src/components/entity-chat-panel';

interface ChatTabProps {
  /** Serialized attachment key (e.g. `markdown_file-<path>`). */
  target: string | null;
}

export function ChatTab({ target }: ChatTabProps) {
  return <EntityChatPanel target={target} className="h-full" />;
}
