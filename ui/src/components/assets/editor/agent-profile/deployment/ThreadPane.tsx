import { useEffect, useRef } from 'react';
import { Trans } from '@lingui/react/macro';
import { Ban, Bot, XCircle } from 'lucide-react';
import { AgenticProcess, TypeId, type Deployment, type DeploymentThread, type TimelineEvent } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ConversationLiveActivity } from '@src/components/conversation/ConversationLiveActivity';
import { SimpleChatPane } from '@src/components/terminal/interactive-terminal/SimpleChatPane';
import { cn } from '@src/lib/utils';
import { useThreadIcon } from './DeploymentThreads';
import { ThreadStatus } from './ThreadStatus';
import { useThreadEvents } from './use-deployment-threads';

export type ThreadView = 'events' | 'agent';

interface ThreadPaneProps {
  deployment: Deployment;
  thread: DeploymentThread;
  view: ThreadView;
  /** A moment the Agent view opens at (a turn picked in Events). */
  focusAt: string | null;
  onView: (view: ThreadView, focusAt?: string | null) => void;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function EventRow({ event, onTurn }: { event: TimelineEvent; onTurn: (at: string) => void }) {
  if (event.kind === 'message_in' || event.kind === 'reply_sent') {
    const mine = event.kind === 'reply_sent';
    return (
      <div className={cn('flex max-w-[80%] flex-col gap-0.5', mine ? 'items-end self-end' : 'items-start self-start')} data-testid={`thread-event-${event.kind}`}>
        <span className="px-1 text-[11px] text-muted-foreground">
          {event.who} · {time(event.at)}
        </span>
        <span
          className={cn(
            'whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13px] leading-snug',
            mine ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'rounded-tl-sm bg-muted',
          )}
        >
          {event.text}
        </span>
      </div>
    );
  }
  if (event.kind === 'turn_started') {
    return (
      <button
        type="button"
        onClick={() => onTurn(event.at)}
        className="flex items-center gap-2 self-center rounded-full border px-3 py-1 text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
        data-testid="thread-event-turn_started"
      >
        <Bot className="h-3.5 w-3.5" />
        <Trans>Agent turn</Trans> · {time(event.at)}
      </button>
    );
  }
  const failed = event.kind === 'turn_failed';
  const Icon = failed ? XCircle : Ban;
  return (
    <div className={cn('flex items-center gap-2 self-center text-[11.5px]', failed ? 'text-destructive' : 'text-amber-600')} data-testid={`thread-event-${event.kind}`}>
      <Icon className="h-3.5 w-3.5" />
      {failed ? <Trans>Turn failed</Trans> : <Trans>Sender refused</Trans>}
      {event.text ? ` · ${event.text}` : ''} · {time(event.at)}
    </div>
  );
}

/**
 * One thread, on the right: its events as they happened — what came in, what the agent answered, each
 * agent turn — live while it runs (a call's words as they are spoken), and the agent's side of it: the
 * process's chat, opened at a turn when one is picked.
 */
export function ThreadPane({ deployment, thread, view, focusAt, onView }: ThreadPaneProps) {
  const Icon = useThreadIcon()(thread);
  const { events, error } = useThreadEvents(deployment, thread);
  const { data: process } = useEntity<AgenticProcess>(
    thread.process_id ? new TypeId(AgenticProcess.type, thread.process_id) : null,
    { watch: true },
  );
  const ordered = [...(events ?? [])].reverse();
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view === 'events') bottom.current?.scrollIntoView({ block: 'end' });
  }, [ordered.length, view]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="deployment-thread-pane">
      <header className="flex flex-wrap items-center gap-2.5 border-b px-5 py-2.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="truncate text-[13px] font-semibold">{thread.title || thread.who}</h2>
        <ThreadStatus status={thread.status} />
        <span className="text-[11.5px] text-muted-foreground">
          {thread.channel} · <Trans>{thread.messages} messages · {thread.turns} turns</Trans>
        </span>
        <div className="ms-auto flex rounded-md border p-0.5 text-[12px]" role="tablist">
          {(['events', 'agent'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              disabled={v === 'agent' && !process}
              onClick={() => onView(v)}
              className={cn('rounded px-2.5 py-1', view === v ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}
              data-testid={`thread-view-${v}`}
            >
              {v === 'events' ? <Trans>Events</Trans> : <Trans>Agent</Trans>}
            </button>
          ))}
        </div>
      </header>
      {view === 'agent' && process ? (
        <SimpleChatPane key={process.id} process={process} focusAt={focusAt} className="min-h-0 flex-1" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-2.5 px-5 py-4" data-testid="thread-events">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {ordered.map((event) => (
              <EventRow key={`${event.kind}:${event.message_id || event.at}`} event={event} onTurn={(at) => onView('agent', at)} />
            ))}
            {(thread.status === 'live' || thread.status === 'working') && (
              <ConversationLiveActivity conversationId={thread.conversation_id} run={process ?? null} messageCount={ordered.length} />
            )}
            <div ref={bottom} />
          </div>
        </div>
      )}
    </div>
  );
}
