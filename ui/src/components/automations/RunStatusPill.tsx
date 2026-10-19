/**
 * A run's state as a coloured dot + word. Colour is never the only signal, and
 * text stays the foreground colour on every state — a failure is a tinted pill
 * with a red border, never red text on a dark background.
 */
import type { RunStatus } from '@sdk';
import { cn } from '@src/lib/utils';
import { useAutomationWords } from './automation-words';

const DOT: Record<RunStatus, string> = {
  succeeded: 'bg-emerald-500',
  launched: 'bg-sky-500',
  running: 'bg-sky-500 animate-pulse',
  failed: 'bg-red-500',
  skipped: 'bg-amber-500',
};

const PILL: Record<RunStatus, string> = {
  succeeded: 'border-transparent',
  launched: 'border-transparent',
  running: 'border-transparent',
  failed: 'border-red-500/60 bg-red-500/10',
  skipped: 'border-amber-500/50 bg-amber-500/10',
};

export function RunStatusDot({ status, className }: { status: RunStatus; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[status], className)} />;
}

export function RunStatusPill({ status, className }: { status: RunStatus; className?: string }) {
  const words = useAutomationWords();
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium text-foreground',
        PILL[status],
        className,
      )}
    >
      <RunStatusDot status={status} />
      {words.status(status)}
    </span>
  );
}
