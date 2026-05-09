import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { IndexProgressTable, TypeProgressRow } from '@sdk';

export type { IndexProgressTable, TypeProgressRow };

function rowState(row: TypeProgressRow, current: string | null): 'done' | 'current' | 'pending' {
  if (current === row.type_name) return 'current';
  if (row.total > 0 && row.done >= row.total) return 'done';
  return 'pending';
}

export function ActivityProgressBar({
  table,
  onClick,
}: {
  table: IndexProgressTable;
  onClick: () => void;
}) {
  const pct = table.total > 0 ? (table.done / table.total) * 100 : 0;
  const isDone = table.text === 'complete';
  const label = table.total > 0
    ? `${table.done.toLocaleString()}/${table.total.toLocaleString()}`
    : `${table.done.toLocaleString()}`;

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-md px-1 py-0.5 hover:bg-accent/30 transition-colors"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium tabular-nums">{label} records</span>
        {table.current ? (
          <span className="text-xs text-muted-foreground truncate max-w-[180px] ml-2 font-mono">
            {table.current}
          </span>
        ) : isDone ? (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">done</span>
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
  title = 'Progress',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  table: IndexProgressTable | null;
  title?: string;
}) {
  if (!table) return null;

  const headerLabel = table.total > 0
    ? `${table.done.toLocaleString()}/${table.total.toLocaleString()}`
    : `${table.done.toLocaleString()} records`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">
            {title} — {headerLabel}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-1 max-h-[70vh] overflow-y-auto pr-1">
          {table.rows.length === 0 && (
            <p className="text-xs text-muted-foreground italic px-3 py-2">No records discovered yet.</p>
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
                {row.total > 0 && (
                  <div className="h-1 w-16 rounded-full bg-muted overflow-hidden shrink-0">
                    <div
                      className={`h-full ${state === 'done' ? 'bg-emerald-500' : 'bg-primary'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
