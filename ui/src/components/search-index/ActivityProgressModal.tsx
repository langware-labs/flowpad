import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { PROGRESS_TEXT_COMPLETE, type IndexProgressTable, type TypeProgressRow } from '@sdk';
import { rowState } from './activity-labels';
import { Trans, useLingui } from '@lingui/react/macro';

export type { IndexProgressTable, TypeProgressRow };

/**
 * The 16px per-row progress bar shared by the type list (ActivityIndicator)
 * and this modal. Caller guards on a known total; `pct` is `done/total*100`.
 * `done` paints the emerald "finished" fill instead of the in-flight primary.
 */
export function MiniProgressBar({ pct, done = false }: { pct: number; done?: boolean }) {
  return (
    <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all ${done ? 'bg-emerald-500' : 'bg-primary'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function ActivityProgressBar({
  table,
  onClick,
}: {
  table: IndexProgressTable;
  onClick: () => void;
}) {
  const pct = table.total > 0 ? (table.done / table.total) * 100 : 0;
  const isDone = table.text === PROGRESS_TEXT_COMPLETE;
  const label = table.total > 0
    ? `${table.done.toLocaleString()}/${table.total.toLocaleString()}`
    : `${table.done.toLocaleString()}`;

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-md px-1 py-0.5 hover:bg-accent/30 transition-colors"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium tabular-nums"><Trans>{label} records</Trans></span>
        {table.current ? (
          <span className="text-xs text-muted-foreground truncate max-w-[180px] ml-2 font-mono">
            {table.current}
          </span>
        ) : isDone ? (
          <span className="text-xs text-emerald-600 dark:text-emerald-400"><Trans>done</Trans></span>
        ) : null}
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${isDone ? 'bg-emerald-500' : 'bg-primary'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </button>
  );
}

export function ActivityProgressModal({
  open,
  onOpenChange,
  table,
  title,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  table: IndexProgressTable | null;
  title?: string;
}) {
  const { t } = useLingui();
  if (!table) return null;

  const displayTitle = title || t`Progress`;
  const headerLabel = table.total > 0
    ? `${table.done.toLocaleString()}/${table.total.toLocaleString()}`
    : `${table.done.toLocaleString()} records`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">
            {displayTitle} — {headerLabel}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-1 max-h-[70vh] overflow-y-auto pr-1">
          {table.rows.length === 0 && (
            <p className="text-xs text-muted-foreground italic px-3 py-2"><Trans>No records discovered yet.</Trans></p>
          )}
          {table.rows.map((row) => {
            const state = rowState(row, table.current);
            const pct = row.total > 0 ? (row.done / row.total) * 100 : 0;
            const Icon =
              state === 'done' ? CheckCircle2 :
              state === 'current' ? Loader2 :
              Circle;
            const iconClass =
              state === 'done' ? 'text-emerald-500' :
              state === 'current' ? 'text-primary animate-spin' :
              'text-muted-foreground';
            const rowClass =
              state === 'current' ? 'border border-primary/30 bg-primary/5' :
              state === 'pending' ? 'opacity-60' :
              '';
            const countLabel = row.total > 0
              ? `${row.done.toLocaleString()}/${row.total.toLocaleString()}`
              : row.done.toLocaleString();

            return (
              <div
                key={row.type_name}
                className={`flex items-center gap-2 rounded-md px-3 py-1.5 ${rowClass}`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                <span className="font-mono text-sm truncate flex-1">{row.type_name}</span>
                <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                  {countLabel}
                </span>
                {row.total > 0 && <MiniProgressBar pct={pct} done={state === 'done'} />}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
