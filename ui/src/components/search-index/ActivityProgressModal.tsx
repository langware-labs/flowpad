import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { ActivityProgress } from '@sdk';

export type { ActivityProgress };

export function ActivityProgressBar({
  progress,
  onClick,
}: {
  progress: ActivityProgress;
  onClick: () => void;
}) {
  const pct = progress.total > 0 ? (progress.done.length / progress.total) * 100 : 0;
  const isDone = progress.current === null && progress.pending.length === 0;

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-md px-1 py-0.5 hover:bg-accent/30 transition-colors"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium tabular-nums">
          {progress.done.length}/{progress.total} types
        </span>
        {progress.current ? (
          <span className="text-xs text-muted-foreground truncate max-w-[180px] ml-2 font-mono">
            {progress.current}
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
  progress,
  title = 'Progress',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  progress: ActivityProgress | null;
  title?: string;
}) {
  if (!progress) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">
            {title} — {progress.done.length}/{progress.total}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 max-h-[70vh] overflow-y-auto pr-1">
          {/* Current */}
          {progress.current && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                Current
              </p>
              <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                <span className="font-mono text-sm truncate flex-1">{progress.current}</span>
              </div>
            </div>
          )}

          {/* Done */}
          {progress.done.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                Done ({progress.done.length})
              </p>
              <div className="flex flex-col gap-0.5">
                {progress.done.map((t) => (
                  <div key={t} className="flex items-center gap-2 px-3 py-1.5 rounded-md">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <span className="font-mono text-sm truncate flex-1 text-muted-foreground">{t}</span>
                    {progress.counts?.[t] !== undefined && (
                      <span className="text-xs tabular-nums text-muted-foreground/60 shrink-0">
                        {progress.counts[t].toLocaleString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pending */}
          {progress.pending.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                Pending ({progress.pending.length})
              </p>
              <div className="flex flex-col gap-0.5">
                {progress.pending.map((t) => (
                  <div key={t} className="flex items-center gap-2 px-3 py-1.5 rounded-md opacity-50">
                    <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-sm truncate">{t}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
