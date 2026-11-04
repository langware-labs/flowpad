import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useState } from 'react';
import { CountBubble, ScopeTabs, StatChip } from './StatChips';
import type { AssetCounter, AssetCounterGroup } from './types';

/** The scopes a group's counters fall into, in first-seen order. */
function scopesOf<T>(counters: AssetCounter<T>[]) {
  const seen = new Map<string, AssetCounter<T>['scope'] & {}>();
  for (const counter of counters)
    if (counter.scope && !seen.has(counter.scope.key)) seen.set(counter.scope.key, counter.scope);
  return [...seen.values()];
}

/**
 * A group's counters as a scope switch plus `label (count)` chips. The number is the length of
 * the same list the table shows; a chip click only navigates (URL-first) — the table view reads
 * group + counter from the URL. The scope switch is local view state: it changes which chips
 * show here, not what the dock shows.
 */
export function AssetCounterChips<T>({ group, className }: { group: AssetCounterGroup<T>; className?: string }) {
  const { navigation } = useDockNavigation();
  const counters = group.useCounters();
  const scopes = scopesOf(counters);
  const [scopeKey, setScopeKey] = useState<string | undefined>(undefined);
  const scope = scopes.find((s) => s.key === scopeKey) ?? scopes[0];
  const shown = scope ? counters.filter((c) => c.scope?.key === scope.key) : counters;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} data-testid={`asset-counters-${group.id}`}>
      {scopes.length > 1 && scope && <ScopeTabs value={scope.key} options={scopes} onChange={setScopeKey} />}
      {shown.map((counter) => (
        <StatChip
          key={counter.key}
          label={counter.chipLabel ?? counter.label}
          onClick={() => navigation.openAssetList(group.id, counter.key)}
          data-testid="asset-counter"
          data-counter={counter.key}
        >
          <CountBubble
            value={counter.items.length}
            tone={counter.tone}
            isLoading={counter.isLoading}
            testId="asset-counter-value"
          />
        </StatChip>
      ))}
    </div>
  );
}

/** A group's heading with its counter chips beside it. */
export function AssetCounterRow<T>({ group, className }: { group: AssetCounterGroup<T>; className?: string }) {
  return (
    <section className={cn('flex w-full flex-wrap items-center gap-3 text-start', className)}>
      <h3 className="text-sm font-semibold text-foreground">{labelForType(group.type)}</h3>
      <AssetCounterChips group={group} />
    </section>
  );
}
