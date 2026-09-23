import { Trans, useLingui } from '@lingui/react/macro';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { Input } from '@src/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { matchesQuickSearch, quickSearchTerms } from './quick-search';
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
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const counters = group.useCounters();
  const active = counters.find((counter) => counter.key === counterKey) ?? counters[0];
  // A transient filter over the rows on screen, not a new list — so it stays
  // local and survives switching tabs rather than living in the URL.
  const [query, setQuery] = useState('');
  // Lower-cased once per list, not once per row per keystroke.
  const indexed = useMemo(
    () => (active?.items ?? []).map((item) => ({ item, haystack: group.searchText(item).toLowerCase() })),
    [active?.items, group],
  );
  const rows = useMemo(() => {
    const terms = quickSearchTerms(query);
    return indexed.filter(({ haystack }) => matchesQuickSearch(haystack, terms)).map(({ item }) => item);
  }, [indexed, query]);

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

      <div className="relative mb-3 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          placeholder={t`Quick search`}
          aria-label={t`Quick search`}
          className="pl-9 pr-9"
          data-testid="asset-list-search"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label={t`Clear search`}
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {group.columns.map((column) => (
                <TableHead key={column.key} className={column.className}>
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((item) => (
              <TableRow
                key={group.itemKey(item)}
                onClick={() => navigation.openDock(group.itemPointer(item))}
                className="cursor-pointer"
                data-testid="asset-list-row"
              >
                {group.columns.map((column) => (
                  <TableCell key={column.key} className={column.className}>
                    {column.cell(item)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {active && !active.isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={group.columns.length} className="py-10 text-center text-muted-foreground">
                  {active.items.length === 0 ? <Trans>Nothing here yet.</Trans> : <Trans>No matches for “{query}”.</Trans>}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
