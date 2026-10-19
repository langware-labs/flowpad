import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { Skeleton } from '@src/components/ui/skeleton';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { AssetCounterGroup } from './types';

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
          className="group flex max-w-40 items-center gap-1.5 rounded-full border border-border bg-card/60 px-2.5 py-0.5 text-xs transition-colors hover:border-primary/50 hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
