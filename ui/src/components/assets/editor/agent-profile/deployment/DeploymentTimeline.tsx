import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Ban, Play, Send, XCircle } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { DataSource, TimelineEvent } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { cn } from '@src/lib/utils';

/** The glyph of an event that is not a message arriving — a message shows its channel's own icon. */
const KIND_ICON: Partial<Record<TimelineEvent['kind'], LucideIcon>> = {
  reply_sent: Send,
  turn_started: Play,
  turn_failed: XCircle,
  refused: Ban,
};

/** The key an event is selected by: its process and its moment. */
export function eventKey(event: Pick<TimelineEvent, 'process_id' | 'at'>): string {
  return `${event.process_id}@${event.at}`;
}

interface DeploymentTimelineProps {
  events: TimelineEvent[];
  /** The selected event (`eventKey`), and the process it belongs to — its siblings are tinted. */
  selectedKey: string | null;
  selectedProcess: string | null;
  onSelect: (event: TimelineEvent) => void;
  hasOlder: boolean;
  onLoadOlder: () => void;
}

/**
 * One list of what happened on a deployment, newest first: a message in (its channel's icon), a
 * turn started, a reply sent, a sender refused. Selecting an event opens its process.
 */
export function DeploymentTimeline({ events, selectedKey, selectedProcess, onSelect, hasOlder, onLoadOlder }: DeploymentTimelineProps) {
  const { t } = useLingui();
  const { specFor } = useSourceSpecs();
  const { data: sources } = useEntitiesQuery<DataSource>(sourcesQuery);
  const byId = useMemo(() => new Map((sources ?? []).map((s) => [s.id, s])), [sources]);

  const kindLabel: Record<TimelineEvent['kind'], string> = {
    message_in: t`message in`,
    reply_sent: t`reply sent`,
    turn_started: t`started`,
    turn_failed: t`failed`,
    refused: t`refused`,
  };

  if (!events.length) {
    return (
      <p className="px-5 py-6 text-sm text-muted-foreground" data-testid="deployment-timeline-empty">
        <Trans>Nothing has reached this deployment yet. A message on one of its channels shows up here.</Trans>
      </p>
    );
  }

  let day = '';
  return (
    <ol className="flex flex-col py-2" data-testid="deployment-timeline">
      {events.map((event) => {
        const when = new Date(event.at);
        const thisDay = when.toLocaleDateString();
        const header = thisDay !== day ? thisDay : null;
        day = thisDay;
        const source = byId.get(event.data_source_id);
        const Icon = KIND_ICON[event.kind] ?? sourceIcon(source ? specFor(source.provider) : undefined, source?.channel ?? event.channel);
        const key = eventKey(event);
        const selected = key === selectedKey;
        const sibling = !selected && !!selectedProcess && event.process_id === selectedProcess;
        const warn = event.kind === 'refused';
        return (
          <li key={`${key}:${event.kind}:${event.message_id}`} className="contents">
            {header && (
              <div className="px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{header}</div>
            )}
            <button
              type="button"
              disabled={!event.process_id}
              onClick={() => onSelect(event)}
              data-testid={`timeline-event-${event.kind}`}
              data-selected={selected || undefined}
              className={cn(
                'grid grid-cols-[3rem_1.5rem_minmax(0,1fr)] items-start gap-2.5 px-5 py-1.5 text-left',
                event.process_id ? 'hover:bg-muted' : 'cursor-default',
                sibling && 'bg-muted/50',
                selected && 'bg-primary/5 shadow-[inset_3px_0_0_hsl(var(--primary))]',
              )}
            >
              <span className="pt-1 text-right text-[11px] tabular-nums text-muted-foreground">
                {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span
                className={cn(
                  'grid h-6 w-6 place-items-center rounded-full border bg-background',
                  warn && 'text-amber-600',
                  event.kind === 'turn_failed' && 'text-destructive',
                  event.kind !== 'message_in' && !warn && event.kind !== 'turn_failed' && 'text-muted-foreground',
                )}
              >
                <Icon className="h-3 w-3" />
              </span>
              <span className="min-w-0 pt-0.5">
                <span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
                  <span className="truncate font-medium">{event.who || event.channel}</span>
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">{kindLabel[event.kind]}</span>
                  {event.channel && <span className="ms-auto shrink-0 text-[10.5px] text-muted-foreground">{event.channel}</span>}
                </span>
                {event.text && <span className="block truncate text-[12.5px] text-muted-foreground">{event.text}</span>}
              </span>
            </button>
          </li>
        );
      })}
      {hasOlder && (
        <li className="px-5 py-2">
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onLoadOlder}>
            <Trans>Load older</Trans>
          </button>
        </li>
      )}
    </ol>
  );
}
