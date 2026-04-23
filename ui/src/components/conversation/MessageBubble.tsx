import type { ConversationMessage } from '@sdk/entities/conversation';
import { MessageActions } from './MessageActions';

interface MessageBubbleProps {
  message: ConversationMessage;
  flowMessageId?: string;
  senderName: string;
}

export function MessageBubble({ message, flowMessageId, senderName }: MessageBubbleProps) {
  return (
    <div
      className={`rounded-lg px-3 py-2 text-sm ${
        message.role === 'sender'
          ? 'bg-primary/10 text-foreground'
          : message.role === 'bot'
          ? 'bg-muted/60 text-foreground/70 italic'
          : 'bg-muted text-foreground'
      }`}
    >
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {message.role === 'bot' ? 'Claude' : senderName || 'Unknown'}
          </span>
          <MessageActions flowMessageId={flowMessageId} />
        </div>
        {message.timestamp && (
          <span className="text-[10px] text-muted-foreground/60">
            {new Date(message.timestamp).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>
      {message.content}
    </div>
  );
}
