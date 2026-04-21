import { EntityChatPanel } from '@src/components/entity-chat-panel';
import type { TypeId } from '@sdk';

interface ChatTabProps {
  target: TypeId | null;
}

export function ChatTab({ target }: ChatTabProps) {
  return <EntityChatPanel target={target} className="h-full" />;
}
