import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { Trans } from '@lingui/react/macro';
import { Skeleton } from '@src/components/ui/skeleton';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { ReactNode } from 'react';
import type { AssetCounterGroup } from './types';

const CHIP_CLASS =
  'group flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-2.5 py-0.5 text-xs transition-colors hover:border-primary/50 hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * A group's counters as small clickable chips. The number is the length of the
 * same list the table shows; a click only navigates (URL-first) — the table
 * view reads group + counter from the URL.
 */
export function AssetCounterChips<T>({ group, className }: { group: AssetCounterGroup<T>; className?: string }) {
  const { navigation } = useDockNavigation();
  const counters = group.useCounters();

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} data-testid={`asset-counters-${group.id}`}>
      {counters.map((counter) => (
        <button
          key={counter.key}
          type="button"
          onClick={() => navigation.openAssetList(group.id, counter.key)}
          className={cn(CHIP_CLASS, 'max-w-40')}
          data-testid="asset-counter"
          data-counter={counter.key}
        >
          <span className="font-semibold tabular-nums text-foreground" data-testid="asset-counter-value">
            {counter.isLoading ? <Skeleton className="h-3 w-3" /> : counter.items.length}
          </span>
          <span className="truncate text-muted-foreground group-hover:text-foreground">{counter.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A group's heading with its counter chips beside it. */
export function AssetCounterRow<T>({ group, className }: { group: AssetCounterGroup<T>; className?: string }) {
  return (
    <section className={cn('flex w-full items-center gap-3 text-start', className)}>
      <h3 className="text-sm font-semibold text-foreground">{labelForType(group.type)}</h3>
      <AssetCounterChips group={group} />
    </section>
  );
}

function CountValue({ value, isLoading }: { value: number; isLoading: boolean }) {
  return (
    <span className="font-semibold tabular-nums text-foreground">
      {isLoading ? <Skeleton className="h-3 w-3" /> : value}
    </span>
  );
}

/** One summary chip: `count label`, plus `· ● n active` when `active` is given. */
export function CounterChip({
  count,
  label,
  active,
  isLoading = false,
  onClick,
  testId,
}: {
  count: number;
  label: ReactNode;
  active?: number;
  isLoading?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={CHIP_CLASS} data-testid={testId}>
      <CountValue value={count} isLoading={isLoading} />
      <span className="truncate text-muted-foreground group-hover:text-foreground">{label}</span>
      {active !== undefined && (
        <span className="flex items-center gap-1 text-muted-foreground">
          ·
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              active > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/40',
            )}
          />
          <CountValue value={active} isLoading={isLoading} />
          <Trans>active</Trans>
        </span>
      )}
    </button>
  );
}

/**
 * A whole group as ONE chip: the `all` counter's count and label, and — when the
 * group has an `active` counter — how many of those are active. A click opens
 * the `all` table, which shows each row's status.
 */
export function AssetSummaryChip<T>({
  group,
  onClick,
}: {
  group: AssetCounterGroup<T>;
  /** Replaces the default (open the group's table) when the host has its own view. */
  onClick?: () => void;
}) {
  const { navigation } = useDockNavigation();
  const counters = group.useCounters();
  const all = counters.find((c) => c.key === 'all') ?? counters[0];
  const active = counters.find((c) => c.key === 'active');
  if (!all) return null;
  return (
    <CounterChip
      count={all.items.length}
      label={all.label}
      active={active?.items.length}
      isLoading={all.isLoading || !!active?.isLoading}
      onClick={onClick ?? (() => navigation.openAssetList(group.id, all.key))}
      testId={`summary-chip-${group.id}`}
    />
  );
}
