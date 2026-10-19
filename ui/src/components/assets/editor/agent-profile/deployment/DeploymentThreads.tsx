import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import type { DataSource, DeploymentThread } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { cn } from '@src/lib/utils';
import { ThreadStatus } from './ThreadStatus';

/** The icon a thread's channel wears — its source's own (a phone, a chat, a mailbox). */
export function useThreadIcon() {
  const { specFor } = useSourceSpecs();
  const { data: sources } = useEntitiesQuery<DataSource>(sourcesQuery);
  const byId = useMemo(() => new Map((sources ?? []).map((s) => [s.id, s])), [sources]);
  return (thread: Pick<DeploymentThread, 'data_source_id' | 'channel'>) => {
    const source = byId.get(thread.data_source_id);
    return sourceIcon(source ? specFor(source.provider) : undefined, source?.channel ?? thread.channel);
  };
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}

interface DeploymentThreadsProps {
  threads: DeploymentThread[];
  selected: string | null;
  onSelect: (thread: DeploymentThread) => void;
}

/**
 * The deployment's threads — one per conversation, a whole phone call included — the active ones
 * first. A thread says who it is with, on which channel, its latest line, and what is happening in
 * it now. Selecting one shows its events.
 */
export function DeploymentThreads({ threads, selected, onSelect }: DeploymentThreadsProps) {
  const iconFor = useThreadIcon();
  if (!threads.length) {
    return (
      <p className="px-5 py-6 text-sm text-muted-foreground" data-testid="deployment-threads-empty">
        <Trans>No conversations yet. A message or a call on one of its channels starts one.</Trans>
      </p>
    );
  }
  return (
    <ol className="flex flex-col py-1" data-testid="deployment-threads">
      {threads.map((thread) => {
        const Icon = iconFor(thread);
        const active = thread.status === 'live' || thread.status === 'working';
        return (
          <li key={thread.conversation_id}>
            <button
              type="button"
              onClick={() => onSelect(thread)}
              data-testid={`deployment-thread-${thread.conversation_id}`}
              data-status={thread.status}
              data-selected={thread.conversation_id === selected || undefined}
              className={cn(
                'grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 text-left hover:bg-muted',
                thread.conversation_id === selected && 'bg-primary/5 shadow-[inset_3px_0_0_hsl(var(--primary))]',
              )}
            >
              <span
                className={cn(
                  'relative mt-0.5 grid h-8 w-8 place-items-center rounded-full border bg-background',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {active && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-green-500" />}
              </span>
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{thread.title || thread.who || thread.channel}</span>
                  <ThreadStatus status={thread.status} />
                </span>
                <span className="block truncate text-[12.5px] text-muted-foreground">{thread.last_text}</span>
              </span>
              <span className="pt-0.5 text-right text-[11px] tabular-nums text-muted-foreground">
                {ago(thread.last_at)}
                <span className="block">{thread.messages}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
