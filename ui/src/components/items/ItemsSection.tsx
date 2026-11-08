import { Trans, useLingui } from '@lingui/react/macro';
import { counterAt, counterKey, selectionOf } from '@src/components/asset-counters/axes';
import { CountBubble, CounterAxes } from '@src/components/asset-counters/StatChips';
import { CounterTable, QuickSearchInput, useQuickSearch } from '@src/components/asset-counters/AssetItems';
import type { AssetCounter, AssetCounterGroup } from '@src/components/asset-counters/types';
import { SegmentedControl } from '@src/components/ui/segmented-control';
import { ItemCard } from './ItemCard';
import { SEGMENTED_ACTIVE, SEGMENTED_BUTTON, SEGMENTED_GROUP, SEGMENTED_IDLE } from '@src/components/ui/segmented';
import { Skeleton } from '@src/components/ui/skeleton';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LayoutGrid, List } from 'lucide-react';
import { type ReactNode, useState } from 'react';

/** How many cards a tab shows before "Load more", and how many each click adds. */
export const PAGE_SIZE = 6;

const GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3';

type View = 'grid' | 'list';

// The tabs hold groups of different item types side by side; each group's own
// functions are typed, the section only passes items back to the group they came from.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGroup = AssetCounterGroup<any>;

export interface TabDef {
  group: AnyGroup;
  /** What the tab says when it has nothing yet. */
  emptyText?: ReactNode;
  /** Label of the empty tab's create button; the button runs `onCreate`. */
  createLabel?: ReactNode;
  /** Shown only while it has items (Issues). */
  hideWhenEmpty?: boolean;
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window / blocked storage: the choice just isn't remembered.
  }
}

/** Every tab's counters. A surface's tab list is a constant, so the hooks run in the same order every render. */
function useTabCounters(tabs: TabDef[]): AssetCounter<unknown>[][] {
  return tabs.map((tab) => tab.group.useCounters());
}

type Access = 'all' | 'mine' | 'shared';

function TabButton({
  label,
  count,
  isLoading,
  selected,
  onClick,
  testId,
}: {
  label: ReactNode;
  count: number;
  isLoading: boolean;
  selected: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors',
        selected
          ? 'border-primary font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
      data-testid={testId}
    >
      {label}
      <CountBubble value={count} isLoading={isLoading} />
    </button>
  );
}

/**
 * A home's items — hub and desktop alike: the counters as a sticky tab bar, and below it the selected
 * group's items as cards (or rows), searchable, a page at a time.
 */
export function ItemsSection({
  tabs: TAB_LIST,
  onCreate,
  prefKey,
}: {
  /** This surface's tabs, in order. Hub and desktop differ ONLY in this list, never in how a tab looks. */
  tabs: TabDef[];
  onCreate: () => void;
  /** Where the chosen tab and view are remembered ("hub-home", "desk-home"). */
  prefKey: string;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const all = useTabCounters(TAB_LIST);
  const TAB_KEY = `${prefKey}:tab`;
  const VIEW_KEY = `${prefKey}:view`;

  const [tabId, setTabId] = useState(() => readPref(TAB_KEY) ?? TAB_LIST[0].group.id);
  const [access, setAccess] = useState<Access>('all');
  const [view, setView] = useState<View>(() => (readPref(VIEW_KEY) === 'list' ? 'list' : 'grid'));
  const [selectedKey, setSelectedKey] = useState('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);

  const tabs = TAB_LIST.map((tab, i) => ({
    tab,
    counters: all[i],
    total: counterAt(all[i], selectionOf(all[i]))?.items.length ?? 0,
  })).filter(({ tab, total }) => !tab.hideWhenEmpty || total > 0);
  const current = tabs.find(({ tab }) => tab.group.id === tabId) ?? tabs[0];
  const { group } = current.tab;
  const selection = selectionOf(current.counters, selectedKey);
  const counter = counterAt(current.counters, selection);
  const searched = useQuickSearch(group, counter?.items ?? [], query);
  // Mine / Shared with me reads the role on the card: an owner's item is "mine", anything else was shared.
  // Mine / Shared with me: an item whose role is unknown is in neither, only in All.
  const roleOf = group.role;
  const rows =
    access === 'all' || !roleOf
      ? searched
      : searched.filter((item) => {
          const role = roleOf(item);
          return !!role && (access === 'mine' ? role === 'owner' : role !== 'owner');
        });

  // Every change of what is listed starts again from the first page.
  const selectTab = (id: string) => {
    setTabId(id);
    setSelectedKey('all');
    setAccess('all');
    setQuery('');
    setShown(PAGE_SIZE);
    writePref(TAB_KEY, id);
  };
  const selectCounter = (key: string) => {
    setSelectedKey(key);
    setShown(PAGE_SIZE);
  };
  const search = (value: string) => {
    setQuery(value);
    setShown(PAGE_SIZE);
  };
  const selectView = (next: View) => {
    setView(next);
    writePref(VIEW_KEY, next);
  };
  const open = (item: unknown) => {
    const pointer = group.itemPointer(item);
    if (pointer) navigation.openDockOnThisPage(pointer);
  };

  const isLoading = !!counter?.isLoading;
  const page = rows.slice(0, shown);

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className={GRID}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <p className="py-10 text-center text-sm text-muted-foreground">
        <Trans>No matches for “{query}”.</Trans>
      </p>
    );
  } else if (view === 'grid' && group.card) {
    const card = group.card;
    body = (
      <div className={GRID} data-testid="hub-items-grid">
        {page.map((item) => (
          <ItemCard key={group.itemKey(item)} card={card(item)} onOpen={() => open(item)} />
        ))}
      </div>
    );
  } else {
    body = (
      <div className="rounded-xl border border-border bg-card" data-testid="hub-items-list">
        <CounterTable group={group} rows={page} onOpen={open} rowTestId="hub-items-row" />
      </div>
    );
  }

  return (
    <section className="w-full" data-testid="hub-items">
      <div
        role="tablist"
        className="sticky top-0 z-10 flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-border bg-background"
        data-testid="hub-items-tabs"
      >
        {tabs.map(({ tab, counters, total }) => (
          <TabButton
            key={tab.group.id}
            label={counters[0]?.label}
            count={total}
            isLoading={!!counters[0]?.isLoading}
            selected={tab.group.id === group.id}
            onClick={() => selectTab(tab.group.id)}
            testId={`hub-tab-${tab.group.id}`}
          />
        ))}
      </div>

      {current.total === 0 && !isLoading ? (
        <div
          className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/60 px-6 py-12 text-center"
          data-testid="hub-items-empty"
        >
          <p className="max-w-md text-sm text-muted-foreground">{current.tab.emptyText}</p>
          {current.tab.createLabel && (
            <button
              type="button"
              onClick={onCreate}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="hub-items-create"
            >
              {current.tab.createLabel}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 py-3">
            <QuickSearchInput value={query} onChange={search} className="w-64" testId="hub-items-search" />
            <CounterAxes
              counters={current.counters}
              selection={selection}
              onSelect={(next) => selectCounter(counterKey(next.scope, next.status))}
            />
            {group.role && (
              <SegmentedControl<Access>
                options={[
                  ['all', t`All`],
                  ['mine', t`Mine`],
                  ['shared', t`Shared with me`],
                ]}
                value={access}
                onChange={(value) => {
                  setAccess(value);
                  setShown(PAGE_SIZE);
                }}
                ariaLabel={t`Access`}
                testId="items-access"
              />
            )}
            <div role="radiogroup" className={cn(SEGMENTED_GROUP, 'ml-auto')}>
              {(
                [
                  ['grid', LayoutGrid, t`Grid view`],
                  ['list', List, t`List view`],
                ] as const
              ).map(([value, Icon, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={view === value}
                  aria-label={label}
                  onClick={() => selectView(value)}
                  className={cn(SEGMENTED_BUTTON, view === value ? SEGMENTED_ACTIVE : SEGMENTED_IDLE)}
                  data-testid={`hub-items-view-${value}`}
                >
                  <Icon className="size-3.5" />
                </button>
              ))}
            </div>
          </div>

          {body}

          {!isLoading && rows.length > 0 && (
            <div className="flex items-center justify-center gap-3 py-4 text-xs text-muted-foreground">
              <span className="tabular-nums" data-testid="hub-items-shown">
                <Trans>
                  Showing {page.length} of {rows.length}
                </Trans>
              </span>
              {page.length < rows.length && (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + PAGE_SIZE)}
                  className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
                  data-testid="hub-items-load-more"
                >
                  <Trans>Load more</Trans>
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
