import { useCallback, useSyncExternalStore } from 'react';
import { dataManager, type AgenticProcess, type TypeId } from '@sdk';
import { ContextEntityChip, chipStyleFor, iconForEntity } from '@src/components/conversation/EntityChip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';

const isSource = (type: string) => type === 'conversation' || type === 'flow_message';
/** The callbacks this session set for later (`flow process schedule`) — linked both ways, shown here. */
const triggersOf = (process: AgenticProcess) =>
  (process.privateContextEntities ?? []).filter((tid) => tid.type === 'trigger');
const COUNTED = { flow_message: { label: 'messages', slug: 'messages' }, trigger: { label: 'callbacks', slug: 'triggers' } };

/** The conversation and/or messages a session was started from or sent — one chip each; several messages
 *  fold into one chip with a count that opens their list. */
export function ProcessSourceChips({ process }: { process: AgenticProcess }) {
  // Own subscription: re-render when the session's attached sources change, not on every toolbar tick.
  const key = useSyncExternalStore(
    useCallback((cb) => dataManager.subscribe(process.typeId, cb, false), [process]),
    () =>
      [
        ...(process.sharedContextEntities ?? []).filter((tid) => isSource(tid.type)),
        ...triggersOf(process),
      ]
        .map(String)
        .join(','),
  );
  const triggers = triggersOf(process);
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
      {messages.length > 1 && <CountChip type="flow_message" items={messages} />}
      {triggers.length === 1 && <SourceChip tid={triggers[0]} />}
      {triggers.length > 1 && <CountChip type="trigger" items={triggers} />}
    </span>
  );
}

function SourceChip({ tid }: { tid: TypeId }) {
  return (
    // Opaque and on top: the expanded label covers the centered session title instead of mixing with it.
    <span data-testid={`process-source-${tid.type}`} className="relative z-10 rounded-full bg-background">
      <ContextEntityChip typeId={tid} collapsed />
    </span>
  );
}

/** One chip for several items of one type (messages, callbacks): the type's icon and a count; click lists
 *  them, each opening its own. */
function CountChip({ type, items }: { type: keyof typeof COUNTED; items: TypeId[] }) {
  const Icon = iconForEntity(type);
  const { label, slug } = COUNTED[type];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`${items.length} ${label}`}
          aria-label={`${items.length} ${label}`}
          data-testid={`process-source-${slug}`}
          className={`inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium transition-colors ${chipStyleFor(type)}`}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span
            data-testid={`process-source-${slug}-count`}
            className="min-w-4 rounded-full bg-foreground/10 px-1 text-center text-[10px] leading-4 tabular-nums"
          >
            {items.length}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="flex max-w-[24rem] flex-col items-stretch gap-1 p-1.5">
        {items.map((tid) => (
          <ContextEntityChip key={String(tid)} typeId={tid} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
