import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useState } from 'react';
import { type AxisSelection, counterKey, selectionOf } from './axes';
import { CounterAxes } from './StatChips';
import type { AssetCounterGroup } from './types';

/**
 * A group's Scope and Status toggles. Picking an option changes the counts shown here (local view
 * state, not what the dock shows); picking the option that is already selected opens its list —
 * URL-first, the table view reads group + counter from the URL.
 */
export function AssetCounterChips<T>({ group, className }: { group: AssetCounterGroup<T>; className?: string }) {
  const { navigation } = useDockNavigation();
  const counters = group.useCounters();
  const [picked, setPicked] = useState<AxisSelection | null>(null);
  const selection = picked ?? selectionOf(counters);

  return (
    <CounterAxes
      counters={counters}
      selection={selection}
      onSelect={(next) => {
        if (next.scope === selection.scope && next.status === selection.status)
          navigation.openAssetList(group.id, counterKey(next.scope, next.status));
        else setPicked(next);
      }}
      className={className}
    />
  );
}

/** A group's heading with its counter chips beside it. */
export function AssetCounterRow<T>({ group, className }: { group: AssetCounterGroup<T>; className?: string }) {
  return (
    <section
      className={cn('flex w-full flex-wrap items-center gap-3 text-start', className)}
      data-testid={`asset-counters-${group.id}`}
    >
      <h3 className="text-sm font-semibold text-foreground">{labelForType(group.type)}</h3>
      <AssetCounterChips group={group} />
    </section>
  );
}
