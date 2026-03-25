import type { SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import { SnifferScope, SnifferLevel, type PipelineFilters } from '@src/hooks/use-sniffer-pipeline';
import type { FilterMask } from '@src/hooks/use-event-filter-mask';
import { Badge } from '@src/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { FileText, ScrollText, Webhook } from 'lucide-react';
import { EventOneLiner } from './event-summaries';
import { EventTooltipContent, getEventColor, getEventIcon, navigateToTranscript } from './event-utils';
import { FilterMaskIndicator } from './FilterMaskIndicator';

// ---------------------------------------------------------------------------
// EventListPanel — shared event list body used by both EventSnifferChip
// popover and SessionEventsDialog.
// ---------------------------------------------------------------------------

export interface EventListPanelProps {
  /** Already-filtered events to display (newest first). */
  events: SnifferEvent[];
  /** Current pipeline filter state (for rendering scope/level toggles). */
  filters: PipelineFilters;
  /** Called when scope or level changes. */
  onFilterChange: (update: Partial<PipelineFilters>) => void;
  /** Active filter mask. */
  mask: FilterMask;
  onMaskRemove: (key: string) => void;
  onMaskClearAll: () => void;
  /** Optional clear button callback. When provided a "Clear" link appears. */
  onClear?: () => void;
  /** Called after a navigation action so the host can close its popover/dialog. */
  onDismiss?: () => void;
  /** Max events to show. Defaults to all. */
  maxEvents?: number;
}

export function EventListPanel({
  events,
  filters,
  onFilterChange,
  mask,
  onMaskRemove,
  onMaskClearAll,
  onClear,
  onDismiss,
  maxEvents,
}: EventListPanelProps) {
  const { navigation } = useDockNavigation();
  const displayEvents = maxEvents !== undefined ? events.slice(0, maxEvents) : events;

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="flex items-center justify-between px-1 pb-1">
        <p className="text-xs font-medium text-muted-foreground">
          {events.length} {events.length === 1 ? 'Event' : 'Events'} captured
        </p>
        {onClear && events.length > 0 && (
          <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {/* Filters */}
      <div className="flex items-center gap-4 border-b border-border px-1 pb-2">
        <FilterMaskIndicator mask={mask} onRemove={onMaskRemove} onClearAll={onMaskClearAll} />
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-muted-foreground">Scope</span>
          <div className="flex items-center rounded-md border bg-muted/50">
            {([SnifferScope.All, SnifferScope.Project]).map((value, i) => (
              <button
                key={value}
                className={cn(
                  'px-2 py-0.5 text-[10px] font-medium transition-colors',
                  filters.scope === value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                  i === 0 && 'rounded-l-[5px]',
                  i === 1 && 'rounded-r-[5px]',
                )}
                onClick={() => onFilterChange({ scope: value })}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-muted-foreground">Level</span>
          <div className="flex items-center rounded-md border bg-muted/50">
            {([SnifferLevel.Info, SnifferLevel.Debug]).map((value, i) => (
              <button
                key={value}
                className={cn(
                  'px-2 py-0.5 text-[10px] font-medium transition-colors',
                  filters.level === value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                  i === 0 && 'rounded-l-[5px]',
                  i === 1 && 'rounded-r-[5px]',
                )}
                onClick={() => onFilterChange({ level: value })}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* Event list */}
      {displayEvents.length === 0 ? (
        <p className="px-1 py-2 text-center text-xs text-muted-foreground">No events yet</p>
      ) : (
        displayEvents.map((event) => {
          const Icon = getEventIcon(event.event_type, event);
          return (
            <Tooltip key={event.id}>
              <TooltipTrigger asChild>
                <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent">
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', getEventColor(event))} />
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {event.event_type}
                  </Badge>
                  <EventOneLiner
                    event={event}
                    className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                  />
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className={cn(
                            'rounded p-0.5 transition-colors',
                            event.transcriptDockPointer
                              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              : 'cursor-default text-muted-foreground/30',
                          )}
                          disabled={!event.transcriptDockPointer}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigateToTranscript(event, navigation);
                            onDismiss?.();
                          }}
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">View transcript</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className={cn(
                            'rounded p-0.5 transition-colors',
                            event.hook_entry_id
                              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              : 'cursor-default text-muted-foreground/30',
                          )}
                          disabled={!event.hook_entry_id}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigation.openDock(
                              new DockPointer(ViewType.HOOKS, undefined, {
                                hookId: event.hook_entry_id || '',
                                eventType: event.event_type || '',
                              }),
                            );
                            onDismiss?.();
                          }}
                        >
                          <Webhook className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">View hook</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className={cn(
                            'rounded p-0.5 transition-colors',
                            event.triggerLogDockPointer
                              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              : 'cursor-default text-muted-foreground/30',
                          )}
                          disabled={!event.triggerLogDockPointer}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (event.triggerLogDockPointer) {
                              navigation.openLens('trigger', 'log', event.triggerLogDockPointer.ref);
                            }
                            onDismiss?.();
                          }}
                        >
                          <ScrollText className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">View trigger log</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="max-w-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
              >
                <EventTooltipContent event={event} />
              </TooltipContent>
            </Tooltip>
          );
        })
      )}
    </div>
  );
}
