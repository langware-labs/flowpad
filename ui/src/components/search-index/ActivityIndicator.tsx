import { useSystemTools } from '@src/hooks/use-system-tools';
import { useActivityModalStore } from '@src/store/use-activity-modal-store';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import {
  activityFooterLabel,
  phaseLabelTrailing,
  progressCountsLabel,
  rowState,
} from './activity-labels';
import { ActivityProgressBar } from './ActivityProgressModal';

type StripProps = { variant: 'strip'; className?: string };
type PillProps = { variant: 'pill'; className?: string; 'data-testid'?: string };
type BarProps = { variant: 'bar'; className?: string };
type ListProps = { variant: 'list'; types: string[]; className?: string };

export type ActivityIndicatorProps = StripProps | PillProps | BarProps | ListProps;

const LIST_ROW_STYLE = {
  done: {
    Icon: CheckCircle2,
    iconClass: 'h-4 w-4 text-green-500',
    nameClass: 'text-muted-foreground line-through',
  },
  current: {
    Icon: Loader2,
    iconClass: 'h-4 w-4 animate-spin text-muted-foreground',
    nameClass: '',
  },
  pending: {
    Icon: Circle,
    iconClass: 'h-4 w-4 text-muted-foreground/40',
    nameClass: 'text-muted-foreground/60',
  },
} as const;

export function ActivityIndicator(props: ActivityIndicatorProps) {
  const { currentActivity, progressTable } = useSystemTools();
  const show = useActivityModalStore((s) => s.show);

  if (props.variant === 'list') {
    // Caller chooses what to render when not actively indexing (CTA, confirm step, etc.)
    if (currentActivity !== 'index' || !progressTable) return null;
    const table = progressTable;
    return (
      <div className={props.className ?? 'flex flex-col gap-1 py-2'}>
        {props.types.map((t) => {
          const row = table.rows.find((r) => r.type_name === t);
          const state = row ? rowState(row, table.current) : 'pending';
          const style = LIST_ROW_STYLE[state];
          const Icon = style.Icon;
          return (
            <div key={t} className="flex items-center gap-2 text-sm">
              <Icon className={style.iconClass} />
              <span className={style.nameClass}>{t}</span>
              {row && row.total > 0 && (
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {row.done}/{row.total}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // progressTable can be briefly null between phase-set and the phase's first WS
  // event; the strip/pill/bar stays visible with the phase label, no counts.
  if (!currentActivity) return null;

  if (props.variant === 'bar') {
    return (
      <div className={props.className}>
        {progressTable ? (
          <ActivityProgressBar table={progressTable} onClick={show} />
        ) : (
          <button
            type="button"
            onClick={show}
            className="w-full text-left rounded-md px-1 py-0.5 hover:bg-accent/30 transition-colors flex items-center gap-2"
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">
              {phaseLabelTrailing(currentActivity)}
            </span>
          </button>
        )}
      </div>
    );
  }

  if (props.variant === 'pill') {
    const label = activityFooterLabel(currentActivity, progressTable);
    return (
      <button
        type="button"
        onClick={show}
        className={
          props.className ??
          'flex items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
        }
        title={`${label} — click to open Indexing info`}
        aria-label={label}
        data-testid={props['data-testid'] ?? 'footer-indexing-indicator'}
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="max-w-[320px] truncate tabular-nums">{label}</span>
      </button>
    );
  }

  const phase = phaseLabelTrailing(currentActivity);
  const counts = progressCountsLabel(progressTable);
  const pct =
    progressTable && progressTable.total > 0
      ? (progressTable.done / progressTable.total) * 100
      : null;
  return (
    <button
      type="button"
      onClick={show}
      className={
        props.className ??
        'shrink-0 flex w-full items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors text-left'
      }
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-primary" />
      <span className="text-muted-foreground shrink-0">{phase}</span>
      {progressTable?.current && (
        <span className="font-mono text-foreground truncate max-w-[180px]">
          {progressTable.current}
        </span>
      )}
      {counts && (
        <span className="ml-auto text-muted-foreground shrink-0 tabular-nums">
          {counts}
        </span>
      )}
      {pct !== null && (
        <div className="h-1 w-20 rounded-full bg-muted overflow-hidden shrink-0">
          <div
            className="h-full bg-primary rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </button>
  );
}
