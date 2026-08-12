import type { ReactNode } from 'react';
import { Activity, EyeOff, MessageSquare } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import type { AnnotationElement } from './use-annotation-gutter';
import type { TraceFilters } from './InteractiveTerminal';
import { FIELD_WIDTHS, FIELD_GAP } from './TimeGutter';

const TIME_FIELDS = ['time', 'index', 'line', 'absLine', 'debugTime', 'refTime'] as const;
type TimeField = (typeof TIME_FIELDS)[number];

const TIME_FIELD_LABELS: Record<TimeField, string> = {
  time: 'PTY',
  index: '#seq',
  line: 'L',
  absLine: '@',
  debugTime: 'dur',
  refTime: 'anchor',
};

// Concise — shown after 2000ms hover on column header labels
const TIME_FIELD_DESCS: Record<TimeField, string> = {
  time: 'PTY chunk receipt time',
  index: 'Owner sequence #',
  line: 'Logical line #',
  absLine: 'Absolute row index',
  debugTime: 'PTY segment duration',
  refTime: 'Anchor time range (start→stop)',
};

interface ColumnHeaderBarProps {
  showTrace: boolean;
  traceWidth: number;
  totalTraceEvents: number;
  historicalCount: number;
  liveCount: number;
  showTime: boolean;
  timeWidth: number;
  traceFilters: TraceFilters;
  showAnnotations: boolean;
  annotationsWidth: number;
  annotationElements: AnnotationElement[];
  onToggleTrace: () => void;
  onHideTime: () => void;
  onToggleAnnotations: () => void;
}

export function ColumnHeaderBar({
  showTrace,
  traceWidth,
  totalTraceEvents,
  historicalCount,
  liveCount,
  showTime,
  timeWidth,
  traceFilters,
  showAnnotations,
  annotationsWidth,
  annotationElements,
  onToggleTrace,
  onHideTime,
  onToggleAnnotations,
}: ColumnHeaderBarProps) {
  const activeTimeFields = TIME_FIELDS.filter((k) => traceFilters[k]);

  return (
    <TooltipProvider delayDuration={2000}>
      <div className="flex h-[18px] shrink-0 border-b bg-muted/20 font-mono text-[10px]">
        {/* Trace cell — always rendered, toggles between show-icon and hide-icon */}
        <div
          style={{ width: traceWidth, minWidth: traceWidth }}
          className="flex shrink-0 items-center justify-center border-e border-border/50"
        >
          {showTrace ? (
            <HideButton
              label={
                totalTraceEvents === 0
                  ? 'Hide Trace — no events yet'
                  : `Hide Trace — ${historicalCount > 0 ? `${historicalCount}+${liveCount}` : totalTraceEvents} event${totalTraceEvents === 1 ? '' : 's'}`
              }
              onClick={onToggleTrace}
            />
          ) : (
            <ShowButton label="Show Trace" icon={<Activity className="h-3 w-3" />} onClick={onToggleTrace} />
          )}
        </div>
        {showTime && (
          <div
            style={{ width: timeWidth, minWidth: timeWidth }}
            className="relative flex shrink-0 items-center border-e border-border/50"
          >
            {/* Per-field centered labels — exact widths mirror TimeGutter column layout */}
            <div className="flex items-center overflow-hidden" style={{ gap: FIELD_GAP }}>
              {activeTimeFields.map((field) => (
                <Tooltip key={field}>
                  <TooltipTrigger asChild>
                    <span
                      className="flex cursor-default items-center justify-center overflow-hidden text-muted-foreground/70"
                      style={{ width: FIELD_WIDTHS[field], minWidth: FIELD_WIDTHS[field], fontSize: 9 }}
                    >
                      {TIME_FIELD_LABELS[field]}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {TIME_FIELD_DESCS[field]}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
            {/* Hide button absolutely overlaid at right edge — zero layout impact */}
            <div className="absolute right-0 top-0 flex h-full items-center pe-0.5">
              <HideButton label="Time" onClick={onHideTime} />
            </div>
          </div>
        )}
        {/* XTerm cell — flex-1, no icon */}
        <div className="flex-1" />
        {/* Annotations cell — always rendered, toggles between show-icon and hide-icon */}
        <div
          style={{ width: annotationsWidth, minWidth: annotationsWidth }}
          className="flex shrink-0 items-center justify-center border-s border-border/50"
        >
          {showAnnotations ? (
            <HideButton
              label={
                annotationElements.length === 0
                  ? 'Hide Annotations — none yet'
                  : `Hide Annotations — ${annotationElements.length} annotation${annotationElements.length === 1 ? '' : 's'}`
              }
              onClick={onToggleAnnotations}
            />
          ) : (
            <ShowButton
              label="Show Annotations"
              icon={<MessageSquare className="h-3 w-3" />}
              onClick={onToggleAnnotations}
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function ShowButton({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="inline-flex items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground"
          onClick={onClick}
          aria-label={label}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function HideButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="inline-flex items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
          onClick={onClick}
          aria-label={`Hide ${label}`}
        >
          <EyeOff className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        Hide {label}
      </TooltipContent>
    </Tooltip>
  );
}
