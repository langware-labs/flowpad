import { Check, Circle, Loader2, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type Mark = 'done' | 'failed' | 'running' | 'next';

/** One step of a screen that says what happened, what runs now and what comes next. */
export function Step({ mark, title, detail }: { mark: Mark; title: ReactNode; detail?: ReactNode }) {
  const icon =
    mark === 'done' ? (
      <Check className="size-4 text-emerald-400" />
    ) : mark === 'failed' ? (
      <X className="size-4 text-destructive" />
    ) : mark === 'running' ? (
      <Loader2 className="size-4 animate-spin text-amber-500" />
    ) : (
      <Circle className="size-4 text-muted-foreground" />
    );
  return (
    <li className="flex gap-3 px-3 py-2" data-mark={mark}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {detail && <div className="break-words text-xs text-muted-foreground">{detail}</div>}
      </div>
    </li>
  );
}
