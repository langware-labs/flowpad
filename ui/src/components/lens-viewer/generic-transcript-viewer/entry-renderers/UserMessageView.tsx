import type { UserMessageEntry } from '@sdk/utils/agent-transcript';

interface Props {
  entry: UserMessageEntry;
}

export function UserMessageView({ entry }: Props) {
  return (
    <div
      className="flex flex-col items-end gap-1"
      data-entry-kind="user_message"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
    >
      {entry.role && entry.role !== 'user' && (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{entry.role}</span>
      )}
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary/10 px-3 py-2 text-sm">
        {entry.text || <span className="italic text-muted-foreground">(empty)</span>}
      </div>
    </div>
  );
}
