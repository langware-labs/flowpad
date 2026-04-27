import { MessageList } from './chat/MessageList';
import { MessageInput } from './chat/MessageInput';

export function CollaborationChat() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 flex-shrink-0 items-center border-b px-3 text-xs font-medium text-muted-foreground">
        Conversation
      </div>
      <MessageList />
      <MessageInput />
    </div>
  );
}
