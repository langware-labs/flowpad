import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { MessageActions } from './MessageActions';

interface MessageBubbleProps {
  message: ConversationMessage;
  flowMessageId?: string;
  senderName: string;
  onEditName?: (newName: string) => void;
}

export function MessageBubble({ message, flowMessageId, senderName, onEditName }: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const startEdit = () => {
    setEditValue(senderName);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== senderName && onEditName) {
      onEditName(trimmed);
    }
  };

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
          {message.role !== 'bot' && editing ? (
            <input
              className="border-b border-input bg-transparent text-[11px] font-semibold text-muted-foreground focus:outline-none"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') { setEditing(false); }
              }}
              autoFocus
            />
          ) : (
            <span className="text-[11px] font-semibold text-muted-foreground">
              {message.role === 'bot' ? 'Claude' : senderName || 'Unknown'}
            </span>
          )}
          {message.role !== 'bot' && onEditName && !editing && (
            <button
              onClick={startEdit}
              className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title="Edit name"
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
          )}
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
