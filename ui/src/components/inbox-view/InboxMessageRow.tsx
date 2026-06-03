import { Archive, CheckSquare, Paperclip } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import type { InboxMessage } from './inbox-api';

interface InboxMessageRowProps {
  message: InboxMessage;
  onArchive: (id: string) => void;
  onToggleRead: (id: string, isRead: boolean) => void;
  onClick: (message: InboxMessage) => void;
}

export function InboxMessageRow({ message, onArchive, onToggleRead, onClick }: InboxMessageRowProps) {
  const fileAttachments = message.attachment.filter((a) => a.attachment_type === 'file');

  const formattedDate = message.created_date
    ? (() => {
        const d = new Date(message.created_date);
        const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        return `${date} ${time}`;
      })()
    : '';

  return (
    <div
      className={`group relative flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors hover:bg-accent/50 ${
        message.is_read ? 'opacity-50' : 'border-primary/20 bg-primary/5'
      }`}
      onClick={() => onClick(message)}
    >
      {/* Row header */}
      <div className="flex items-center justify-between gap-2 pr-14">
        <span className={`truncate text-sm ${message.is_read ? 'font-normal text-muted-foreground' : 'font-semibold'}`}>
          {message.sender_name || 'Unknown sender'}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formattedDate}</span>
      </div>

      {/* Message body */}
      <p className="line-clamp-2 text-xs text-muted-foreground">{message.text}</p>

      {/* Attachments preview */}
      {fileAttachments.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1">
          {fileAttachments.map((a) => (
            <span
              key={a.data}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              <Paperclip className="h-2.5 w-2.5" />
              {a.data.split('/').pop()}
            </span>
          ))}
        </div>
      )}

      {/* Action buttons — visible on row hover */}
      <div
        className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="rounded p-1 hover:bg-muted"
              aria-label={message.is_read ? 'Mark unread' : 'Mark read'}
              onClick={() => onToggleRead(message.id, !message.is_read)}
            >
              <CheckSquare className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{message.is_read ? 'Mark unread' : 'Mark read'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="rounded p-1 hover:bg-destructive/10"
              aria-label="Archive"
              onClick={() => onArchive(message.id)}
            >
              <Archive className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Archive — moves to Archived, kept</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
