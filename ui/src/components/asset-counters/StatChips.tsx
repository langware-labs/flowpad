import { Skeleton } from '@src/components/ui/skeleton';
import { cn } from '@src/lib/utils';
import type { ReactNode } from 'react';

/**
 * The stat chip kit, shared by the desktop home and the hub home:
 * a category heading, a scope switch, and `label (count)` chips.
 */

export type CountTone = 'neutral' | 'live' | 'error' | 'warning';

const TONE: Record<CountTone, string> = {
  neutral: 'bg-muted text-foreground ring-1 ring-inset ring-border',
  live: 'bg-emerald-500 text-white dark:text-emerald-950',
  error: 'bg-red-500 text-white',
  warning: 'bg-amber-400 text-amber-950',
};

/** The number in its own bubble; a zero never lights up. */
export function CountBubble({
  value,
  tone = 'neutral',
  isLoading = false,
  testId,
}: {
  value: number;
  tone?: CountTone;
  isLoading?: boolean;
  testId?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
        TONE[value > 0 ? tone : 'neutral'],
      )}
      data-testid={testId}
    >
      {isLoading ? <Skeleton className="h-2.5 w-2.5" /> : value}
    </span>
  );
}

/** A clickable `label + bubbles` chip. */
export function StatChip({
  label,
  children,
  selected = false,
  onClick,
  className,
  ...data
}: {
  label: ReactNode;
  children: ReactNode;
  selected?: boolean;
  onClick: () => void;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full ps-3 pe-1 text-[13px] transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'bg-primary/15 text-foreground ring-1 ring-inset ring-primary/60'
          : 'text-muted-foreground ring-1 ring-inset ring-border hover:bg-accent hover:text-foreground',
        className,
      )}
      {...data}
    >
      <span className="max-w-40 truncate">{label}</span>
      {children}
    </button>
  );
}

/** The scope switch: a track whose selected segment is clearly raised and outlined. */
export function ScopeTabs<K extends string>({
  value,
  options,
  onChange,
}: {
  value: K;
  options: { key: K; label: ReactNode }[];
  onChange: (key: K) => void;
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5 ring-1 ring-inset ring-border"
      data-testid="scope-tabs"
    >
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.key)}
            className={cn(
              'h-6 max-w-40 truncate rounded-md px-2.5 text-[13px] transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected
                ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-primary/60'
                : 'text-muted-foreground hover:bg-background/50 hover:text-foreground',
            )}
            data-scope={option.key}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
