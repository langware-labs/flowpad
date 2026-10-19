import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { PrefKey } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { useEventFilterMask } from '@src/hooks/use-event-filter-mask';
import { usePreference } from '@src/hooks/use-preference';
import { type SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import { useSnifferContext } from '@src/contexts/SnifferContext';
import {
  useSnifferPipeline,
  parsePipelineFilters,
  SnifferLevel,
  type PipelineFilters,
} from '@src/hooks/use-sniffer-pipeline';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Maximize2, Power, Radio } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { EventListPanel } from './EventListPanel';
import { EventTooltipContent, getEventColor, getEventIcon, navigateToTranscript } from './event-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type TimeSpan = '10s' | '1M' | '10' | '60' | '1D';

const TIME_SPANS: { value: TimeSpan; ms: number; tooltip: MessageDescriptor }[] = [
  { value: '10s', ms: 10_000, tooltip: msg`Time span: 10 seconds` },
  { value: '1M', ms: 60_000, tooltip: msg`Time span: 1 minute` },
  { value: '10', ms: 600_000, tooltip: msg`Time span: 10 minutes` },
  { value: '60', ms: 3_600_000, tooltip: msg`Time span: 60 minutes` },
  { value: '1D', ms: 86_400_000, tooltip: msg`Time span: 1 day` },
];

// ---------------------------------------------------------------------------
// HeartbeatChart – flowing, icon-based timeline
// ---------------------------------------------------------------------------

function HeartbeatChart({
  events,
  spanMs,
  onEventClick,
}: {
  events: SnifferEvent[];
  spanMs: number;
  onEventClick?: (event: SnifferEvent) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [hovered, setHovered] = useState(false);

  // Measure container width
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Advance clock every second → icons flow smoothly via CSS transition
  // Pause when user hovers or tab is hidden
  useEffect(() => {
    if (hovered) return;

    const tick = () => setNow(Date.now());
    let id = setInterval(tick, 1_000);

    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(id);
      } else {
        tick();
        id = setInterval(tick, 1_000);
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [hovered]);

  const visible = useMemo(() => {
    if (width === 0) return [];
    const windowStart = now - spanMs;
    return events
      .map((ev) => {
        const t = new Date(ev.timestamp).getTime();
        if (t < windowStart || t > now) return null;
        const x = ((t - windowStart) / spanMs) * width;
        return { x, event: ev };
      })
      .filter(Boolean) as { x: number; event: SnifferEvent }[];
  }, [events, width, now, spanMs]);

  return (
    <div
      ref={containerRef}
      className="relative h-8 w-full overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* baseline */}
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current opacity-10" />

      {/* event icons */}
      {visible.map((pt) => {
        const Icon = getEventIcon(pt.event.event_type, pt.event);
        return (
          <Tooltip key={pt.event.id}>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  'absolute top-1/2 cursor-pointer hover:scale-125 hover:brightness-125',
                  hovered ? '' : 'transition-transform duration-1000 ease-linear',
                  getEventColor(pt.event),
                )}
                style={{ transform: `translate(${pt.x - 8}px, -50%)` }}
                onClick={() => onEventClick?.(pt.event)}
              >
                <Icon className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
            >
              <EventTooltipContent event={pt.event} />
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventSnifferChip
// ---------------------------------------------------------------------------

export function EventSnifferChip() {
  const { t } = useLingui();
  const { snifferEnabled: enabled } = useContext();
  const { events, isLoading, isToggling, enable, disable, clear } = useSnifferContext();
  const { navigation } = useDockNavigation();
  const { mask, removeFilter, clearAll: clearMask } = useEventFilterMask();

  const [timeSpan, setTimeSpan] = usePreference<TimeSpan>(PrefKey.SNIFFER_TIME_SPAN);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [storedFilters, setStoredFilters] = usePreference<PipelineFilters>(PrefKey.SNIFFER_FILTERS);
  const filters = useMemo<PipelineFilters>(() => parsePipelineFilters(JSON.stringify(storedFilters)), [storedFilters]);
  const levelClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleFilterChange = useCallback(
    (update: Partial<PipelineFilters>) => {
      setStoredFilters({ ...storedFilters, ...update });
    },
    [storedFilters, setStoredFilters],
  );

  const pipelineFilters = useMemo<PipelineFilters>(
    () => ({ ...filters, mask: Object.keys(mask).length > 0 ? mask : undefined }),
    [filters, mask],
  );
  const { filteredEvents } = useSnifferPipeline(events, pipelineFilters);

  const handleTimeSpan = useCallback(
    (value: TimeSpan) => {
      setTimeSpan(value);
    },
    [setTimeSpan],
  );

  const handleEventClick = useCallback(
    (event: SnifferEvent) => {
      navigateToTranscript(event, navigation);
    },
    [navigation],
  );

  const lastTenEvents = useMemo(() => {
    return filteredEvents.slice(-10).reverse();
  }, [filteredEvents]);

  const spanMs = TIME_SPANS.find((t) => t.value === timeSpan)!.ms;

  return (
    <div
      data-testid="sniffer-chip"
      data-sniffer-enabled={enabled ? 'true' : 'false'}
      className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2"
    >
      {/* Status dot */}
      <span
        data-testid="sniffer-status-dot"
        className={cn('h-2 w-2 shrink-0 rounded-full', enabled ? 'bg-green-500' : 'bg-muted-foreground/40')}
      />

      {/* Label – opens lens view; double-click toggles level */}
      <button
        className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => {
          // Delay so a double-click can cancel it
          if (levelClickTimer.current) {
            clearTimeout(levelClickTimer.current);
          }
          levelClickTimer.current = setTimeout(() => {
            navigation.openLens('heartbeat', 'events', 'live');
          }, 250);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (levelClickTimer.current) {
            clearTimeout(levelClickTimer.current);
            levelClickTimer.current = null;
          }
          handleFilterChange({ level: filters.level === SnifferLevel.Debug ? SnifferLevel.Info : SnifferLevel.Debug });
        }}
      >
        <Radio className="h-5 w-5" />
        <span className="text-[10px] font-medium uppercase">{filters.level}</span>
      </button>

      {/* Event count + popover trigger */}
      {filteredEvents.length > 0 && <span className="text-xs text-muted-foreground">({filteredEvents.length})</span>}

      {/* Event list popover (via expand button) */}
      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPopoverOpen(false);
            return;
          }
          setPopoverOpen(true);
        }}
      >
        <PopoverTrigger asChild>
          <button
            data-testid="sniffer-expand-button"
            aria-label={t`Expand sniffer event list`}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-96 p-2">
          <EventListPanel
            events={lastTenEvents}
            filters={filters}
            onFilterChange={handleFilterChange}
            mask={mask}
            onMaskRemove={removeFilter}
            onMaskClearAll={clearMask}
            onClear={() => clear()}
            onDismiss={() => setPopoverOpen(false)}
          />
        </PopoverContent>
      </Popover>

      {/* Heartbeat chart */}
      {enabled && (
        <div className="min-w-0 flex-1">
          <HeartbeatChart events={filteredEvents} spanMs={spanMs} onEventClick={handleEventClick} />
        </div>
      )}

      {!enabled && <div className="flex-1" />}

      {/* Time span toggle */}
      {enabled && (
        <div className="flex shrink-0 items-center rounded-md border bg-muted/50">
          {TIME_SPANS.map((span, i) => (
            <Tooltip key={span.value} delayDuration={1500}>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    'px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                    timeSpan === span.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                    i === 0 && 'rounded-s-[5px]',
                    i === TIME_SPANS.length - 1 && 'rounded-e-[5px]',
                  )}
                  onClick={() => handleTimeSpan(span.value)}
                >
                  {span.value}
                </button>
              </TooltipTrigger>
              <TooltipContent>{i18n._(span.tooltip)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}

      {/* Power toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            data-testid="sniffer-power-button"
            aria-label={enabled ? t`Disable sniffer` : t`Enable sniffer`}
            variant="ghost"
            size="icon"
            className={cn('h-7 w-7 shrink-0', enabled && 'text-green-500')}
            onClick={() => void (enabled ? disable() : enable())}
            disabled={isLoading || isToggling}
          >
            <Power className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{enabled ? t`Disable sniffer` : t`Enable sniffer`}</TooltipContent>
      </Tooltip>
    </div>
  );
}
