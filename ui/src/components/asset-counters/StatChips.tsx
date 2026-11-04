import { Trans } from '@lingui/react/macro';
import { Skeleton } from '@src/components/ui/skeleton';
import { cn } from '@src/lib/utils';
import { type ReactNode, useMemo } from 'react';
import { type AxisOption, type AxisSelection, axesOf, counterKey } from './axes';
import type { AssetCounter } from './types';

/**
 * The stat chip kit, shared by the desktop home and the hub home:
 * a category heading, a scope switch, and `label (count)` chips.
 */

export type CountTone = 'neutral' | 'live' | 'error' | 'warning';

const TONE: Record<CountTone, string> = {
  neutral: 'bg-foreground/15 text-foreground',
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
        'inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
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
        'group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40',
        selected
          ? 'bg-foreground/[0.12] font-semibold text-foreground'
          : 'text-foreground/75 hover:bg-foreground/[0.08] hover:text-foreground',
        className,
      )}
      {...data}
    >
      <span className="max-w-40 truncate">{label}</span>
      {children}
    </button>
  );
}

/** One axis: a label and a track of options, each with its count; the selected one is raised. */
export function AxisToggle({
  label,
  options,
  value,
  count,
  isLoading,
  onSelect,
  testId,
}: {
  label: ReactNode;
  options: AxisOption[];
  value?: string;
  count: (key: string) => number;
  isLoading?: boolean;
  onSelect: (key: string) => void;
  testId: string;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-2" data-testid={testId}>
      <span className="text-xs text-foreground/55">{label}</span>
      <div
        role="radiogroup"
        className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-foreground/[0.05] p-0.5 ring-1 ring-inset ring-foreground/15"
      >
        {options.map((option) => {
          const selected = option.key === value;
          const n = count(option.key);
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(option.key)}
              className={cn(
                'inline-flex h-7 max-w-48 items-center gap-1.5 rounded-md pe-1 ps-2.5 text-[13px] transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'bg-foreground/[0.16] font-semibold text-foreground shadow-sm ring-1 ring-foreground/25'
                  : 'text-foreground/65 hover:bg-foreground/[0.08] hover:text-foreground',
              )}
              data-option={option.key}
            >
              {option.tone === 'live' && (
                <span
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', n > 0 ? 'bg-emerald-500' : 'bg-foreground/30')}
                />
              )}
              <span className="truncate">{option.label}</span>
              <CountBubble value={n} tone={option.tone ?? 'neutral'} isLoading={isLoading} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A group's Scope and Status toggles; an axis with one option or none is not shown. */
export function CounterAxes<T>({
  counters,
  selection,
  onSelect,
  className,
}: {
  counters: AssetCounter<T>[];
  selection: AxisSelection;
  onSelect: (next: AxisSelection) => void;
  className?: string;
}) {
  const { scopes, statuses } = useMemo(() => axesOf(counters), [counters]);
  const sizes = useMemo(() => new Map(counters.map((c) => [c.key, c.items.length])), [counters]);
  const sizeAt = (scope?: string, status?: string) => sizes.get(counterKey(scope, status)) ?? 0;
  const isLoading = counters.some((c) => c.isLoading);
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', className)}>
      {scopes.length > 1 && (
        <AxisToggle
          label={<Trans>Scope</Trans>}
          options={scopes}
          value={selection.scope}
          count={(key) => sizeAt(key, selection.status)}
          isLoading={isLoading}
          onSelect={(scope) => onSelect({ ...selection, scope })}
          testId="axis-scope"
        />
      )}
      {statuses.length > 1 && (
        <AxisToggle
          label={<Trans>Status</Trans>}
          options={statuses}
          value={selection.status}
          count={(key) => sizeAt(selection.scope, key)}
          isLoading={isLoading}
          onSelect={(status) => onSelect({ ...selection, status })}
          testId="axis-status"
        />
      )}
    </div>
  );
}
