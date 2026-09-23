import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { Skeleton } from '@src/components/ui/skeleton';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { AssetCounterGroup } from './types';

/**
 * A group's counters as clickable boxes on a home surface. The number is the
 * length of the same list the table shows; a click only navigates
 * (URL-first) — the table view reads group + counter from the URL.
 */
export function AssetCounterRow<T>({ group, className }: { group: AssetCounterGroup<T>; className?: string }) {
  const { navigation } = useDockNavigation();
  const counters = group.useCounters();

  return (
    <section className={cn('w-full text-start', className)} data-testid={`asset-counters-${group.id}`}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labelForType(group.type)}</h2>
      <div className="grid grid-cols-3 gap-3">
        {counters.map((counter) => (
          <button
            key={counter.key}
            type="button"
            onClick={() => navigation.openAssetList(group.id, counter.key)}
            className="group flex min-w-0 flex-col items-start rounded-lg border border-border bg-card/60 px-4 py-3 text-start backdrop-blur-sm transition-colors hover:border-primary/50 hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="asset-counter"
            data-counter={counter.key}
          >
            <span className="text-2xl font-semibold tabular-nums text-foreground" data-testid="asset-counter-value">
              {counter.isLoading ? <Skeleton className="h-7 w-8" /> : counter.items.length}
            </span>
            <span className="w-full truncate text-xs text-muted-foreground group-hover:text-foreground">{counter.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
