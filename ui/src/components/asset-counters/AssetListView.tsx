import { Trans } from '@lingui/react/macro';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { Tabs, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useState } from 'react';
import { CounterTable, NoRows, QuickSearchInput, useQuickSearch } from './AssetItems';
import { findCounterGroup } from './registry';
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
  return <AssetListBody key={group.id} group={group} counterKey={currentDock?.options?.counter} />;
}

function AssetListBody<T>({ group, counterKey }: { group: AssetCounterGroup<T>; counterKey?: string }) {
  const { navigation } = useDockNavigation();
  const counters = group.useCounters();
  const active = counters.find((counter) => counter.key === counterKey) ?? counters[0];
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
        <Tabs value={active?.key} onValueChange={(key) => navigation.openAssetList(group.id, key)}>
          <TabsList>
            {counters.map((counter) => (
              <TabsTrigger
                key={counter.key}
                value={counter.key}
                className="gap-2"
                data-testid="asset-list-tab"
                data-counter={counter.key}
              >
                <span className="max-w-40 truncate">{counter.label}</span>
                <span className="rounded bg-muted px-1.5 text-xs tabular-nums">
                  {counter.isLoading ? '…' : counter.items.length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
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
