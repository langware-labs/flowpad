import { Trans } from '@lingui/react/macro';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useState } from 'react';
import { CounterTable, NoRows, QuickSearchInput, useQuickSearch } from './AssetItems';
import { counterAt, counterKey, selectionOf } from './axes';
import { findCounterGroup } from './registry';
import { CounterAxes } from './StatChips';
import type { AssetCounterGroup } from './types';

/**
 * `/dock/asset-list?group=<g>&counter=<c>` — the table behind one home counter.
 * Everything shown derives from the URL: the group, the active counter, and so
 * the rows.
 */
export function AssetListView() {
  const { currentDock } = useDockNavigation();
  const group = findCounterGroup(currentDock?.options?.group);
  if (!group) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Unknown list</Trans>
      </div>
    );
  }
  // Keyed: a different group runs a different `useCounters`.
  return <AssetListBody key={group.id} group={group} selectedKey={currentDock?.options?.counter} />;
}

function AssetListBody<T>({ group, selectedKey }: { group: AssetCounterGroup<T>; selectedKey?: string }) {
  const { navigation } = useDockNavigation();
  const counters = group.useCounters();
  const selection = selectionOf(counters, selectedKey);
  const active = counterAt(counters, selection);
  // A transient filter over the rows on screen, not a new list — so it stays
  // local and survives switching tabs rather than living in the URL.
  const [query, setQuery] = useState('');
  const rows = useQuickSearch(group, active?.items ?? [], query);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6" data-testid="asset-list-view" data-group={group.id}>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{labelForType(group.type)}</h1>
          {active && <p className="text-sm text-muted-foreground">{active.description}</p>}
        </div>
        <CounterAxes
          counters={counters}
          selection={selection}
          onSelect={(next) => navigation.openAssetList(group.id, counterKey(next.scope, next.status))}
        />
      </header>

      <QuickSearchInput value={query} onChange={setQuery} className="mb-3 max-w-sm" testId="asset-list-search" />

      <div className="rounded-lg border border-border">
        <CounterTable
          group={group}
          rows={rows}
          onOpen={(item) => {
            const pointer = group.itemPointer(item);
            if (pointer) navigation.openDockOnThisPage(pointer);
          }}
          empty={active && !active.isLoading && <NoRows hasItems={active.items.length > 0} query={query} />}
          rowTestId="asset-list-row"
        />
      </div>
    </div>
  );
}
