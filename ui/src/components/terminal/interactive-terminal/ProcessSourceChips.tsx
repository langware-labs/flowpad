import { useCallback, useSyncExternalStore } from 'react';
import { dataManager, type AgenticProcess, type TypeId } from '@sdk';
import { ContextEntityChip, chipStyleFor, iconForEntity } from '@src/components/conversation/EntityChip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';

const isSource = (type: string) => type === 'conversation' || type === 'flow_message';

/** The conversation and/or messages a session was started from or sent — one chip each; several messages
 *  fold into one chip with a count that opens their list. */
export function ProcessSourceChips({ process }: { process: AgenticProcess }) {
  // Own subscription: re-render when the session's attached sources change, not on every toolbar tick.
  const key = useSyncExternalStore(
    useCallback((cb) => dataManager.subscribe(process.typeId, cb, false), [process]),
    () =>
      (process.sharedContextEntities ?? [])
        .filter((tid) => isSource(tid.type))
        .map(String)
        .join(','),
  );
  if (!key) return null;
  const context = process.sharedContextEntities ?? [];
  const conversations = context.filter((tid) => tid.type === 'conversation');
  // Newest first: the context list is append-ordered.
  const messages = context.filter((tid) => tid.type === 'flow_message').reverse();
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-testid="process-source-chips">
      {conversations.map((tid) => (
        <SourceChip key={String(tid)} tid={tid} />
      ))}
      {messages.length === 1 && <SourceChip tid={messages[0]} />}
      {messages.length > 1 && <MessagesChip messages={messages} />}
    </span>
  );
}

function SourceChip({ tid }: { tid: TypeId }) {
  return (
    <span data-testid={`process-source-${tid.type}`}>
      <ContextEntityChip typeId={tid} collapsed />
    </span>
  );
}

/** One chip for several messages: the message icon and a count; click lists them, each opening its message. */
function MessagesChip({ messages }: { messages: TypeId[] }) {
  const Icon = iconForEntity('flow_message');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`${messages.length} messages`}
          aria-label={`${messages.length} messages`}
          data-testid="process-source-messages"
          className={`inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium transition-colors ${chipStyleFor('flow_message')}`}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span
            data-testid="process-source-messages-count"
            className="min-w-4 rounded-full bg-foreground/10 px-1 text-center text-[10px] leading-4 tabular-nums"
          >
            {messages.length}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="flex max-w-[24rem] flex-col items-stretch gap-1 p-1.5">
        {messages.map((tid) => (
          <ContextEntityChip key={String(tid)} typeId={tid} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
