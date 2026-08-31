import { useSystemTools } from '@src/hooks/use-system-tools';
import { showActivityModal } from '@src/store/use-activity-modal-store';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { activityFooterLabel, phaseLabelTrailing, progressCountsLabel, rowState } from './activity-labels';
import { ActivityProgressBar, MiniProgressBar } from './ActivityProgressModal';

type StripProps = { variant: 'strip'; className?: string };
type PillProps = { variant: 'pill'; className?: string; 'data-testid'?: string };
type BarProps = { variant: 'bar'; className?: string };
type ListProps = { variant: 'list'; types?: string[]; className?: string };

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
  const show = showActivityModal;

  if (props.variant === 'list') {
    if (!progressTable) return null;
    const explicit = props.types;
    // Explicit-types callers (Index Now CTA / banner) keep their original
    // index-only behavior. The scanner passes no types: it renders per-type
    // rows for ANY active job (scan / index / clear), derived from the live
    // table — so every type shows its progress as the run advances.
    if (explicit) {
      if (currentActivity !== 'index') return null;
    } else if (!currentActivity) {
      return null;
    }
    const table = progressTable;
    const typeNames = explicit ?? table.rows.map((r) => r.type_name);
    return (
      <div className={props.className ?? 'flex flex-col gap-1 py-2'}>
        {typeNames.map((t) => {
          const row = table.rows.find((r) => r.type_name === t);
          const state = row ? rowState(row, table.current) : 'pending';
          const style = LIST_ROW_STYLE[state];
          const Icon = style.Icon;
          // Per-type % + bar only once the total is known (index loop);
          // null during discovery (total=0) → count-only.
          const pct = row && row.total > 0 ? (row.done / row.total) * 100 : null;
          return (
            <div key={t} className="flex items-center gap-2 text-sm">
              <Icon className={style.iconClass} />
              <span className={style.nameClass}>{t}</span>
              {row && (row.total > 0 || row.done > 0) && (
                <span className="ms-auto flex items-center gap-1.5 text-xs tabular-nums">
                  {/* Actually-(re)indexed this run = done − skipped. Shown on any
                      delta (Fast) run — where some entries were skipped-fresh — so
                      the real work is visible (incl. 0) instead of hidden in done. */}
                  {row.skipped > 0 && <span className="text-foreground">{row.done - row.skipped} indexed</span>}
                  <span className="text-muted-foreground">{row.total > 0 ? `${row.done}/${row.total}` : row.done}</span>
                  {pct !== null && (
                    <>
                      <span className="text-muted-foreground">({Math.round(pct)}%)</span>
                      <MiniProgressBar pct={pct} done={state === 'done'} />
                    </>
                  )}
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
            className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-start transition-colors hover:bg-accent/30"
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">{phaseLabelTrailing(currentActivity)}</span>
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
  const pct = progressTable && progressTable.total > 0 ? (progressTable.done / progressTable.total) * 100 : null;
  return (
    <button
      type="button"
      onClick={show}
      className={
        props.className ??
        'flex w-full shrink-0 items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-start text-xs transition-colors hover:bg-muted/60'
      }
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      <span className="shrink-0 text-muted-foreground">{phase}</span>
      {progressTable?.current && (
        <span className="max-w-[180px] truncate font-mono text-foreground">{progressTable.current}</span>
      )}
      {counts && <span className="ms-auto shrink-0 tabular-nums text-muted-foreground">{counts}</span>}
      {pct !== null && (
        <div className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </button>
  );
}
