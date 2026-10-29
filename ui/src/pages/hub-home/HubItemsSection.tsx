import { Trans, useLingui } from '@lingui/react/macro';
import { InboundWebhooks } from '@sdk';
import { CHIP_CLASS } from '@src/components/asset-counters/AssetCounterRow';
import { CounterTable, LiveDot, QuickSearchInput, useQuickSearch } from '@src/components/asset-counters/AssetItems';
import {
  hubAgentCounterGroup,
  hubDeploymentCounterGroup,
  hubMachineCounterGroup,
} from '@src/components/asset-counters/hub-counters';
import { hubIssueCounterGroup } from '@src/components/asset-counters/issue-counters';
import type { AssetCard, AssetCounter, AssetCounterGroup } from '@src/components/asset-counters/types';
import { openInbound } from '@src/components/inbound/inbound-pointer';
import { useInboundClaims } from '@src/components/inbound/use-inbound';
import { Badge } from '@src/components/ui/badge';
import { SEGMENTED_ACTIVE, SEGMENTED_BUTTON, SEGMENTED_GROUP, SEGMENTED_IDLE } from '@src/components/ui/segmented';
import { Skeleton } from '@src/components/ui/skeleton';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LayoutGrid, List } from 'lucide-react';
import { type ReactNode, useState } from 'react';

/** How many cards a tab shows before "Load more", and how many each click adds. */
export const PAGE_SIZE = 6;

const GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3';
const TAB_KEY = 'hub-home:tab';
const VIEW_KEY = 'hub-home:view';

type View = 'grid' | 'list';

// The tabs hold groups of different item types side by side; each group's own
// functions are typed, the section only passes items back to the group they came from.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGroup = AssetCounterGroup<any>;

interface TabDef {
  group: AnyGroup;
  /** What the tab says when it has nothing yet. */
  emptyText?: ReactNode;
  /** Label of the empty tab's create button; the button runs `onCreate`. */
  createLabel?: ReactNode;
  /** Shown only while it has items (Issues). */
  hideWhenEmpty?: boolean;
}

const TABS: TabDef[] = [
  {
    group: hubAgentCounterGroup,
    emptyText: <Trans>No agents yet. Make one in 60 seconds and talk to it on Slack, WhatsApp or Telegram.</Trans>,
    createLabel: <Trans>Make an agent</Trans>,
  },
  {
    group: hubMachineCounterGroup,
    emptyText: <Trans>No machines yet. Connect this computer or start a sandbox to run agents and terminals.</Trans>,
  },
  {
    group: hubDeploymentCounterGroup,
    emptyText: (
      <Trans>
        A deployment puts one of your agents on a channel — Slack, WhatsApp or Telegram — so people can talk to it
        without opening Flowpad.
      </Trans>
    ),
    createLabel: <Trans>Deploy an agent</Trans>,
  },
  { group: hubIssueCounterGroup, hideWhenEmpty: true },
];

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

/** Every tab's counters. `TABS` is a constant list, so the hooks run in the same order every render. */
function useTabCounters(): AssetCounter<unknown>[][] {
   
  return TABS.map((tab) => tab.group.useCounters());
}

function TabButton({
  label,
  count,
  active,
  isLoading,
  selected,
  onClick,
  testId,
}: {
  label: ReactNode;
  count: number;
  active?: number;
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
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-semibold tabular-nums text-foreground">
        {isLoading ? '…' : count}
      </span>
      {active !== undefined && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <LiveDot active={active > 0} />
          <Trans>{active} active</Trans>
        </span>
      )}
    </button>
  );
}

/**
 * Hub home's items: the counters as a sticky tab bar, and below it the selected
 * group's items as cards (or rows), searchable, a page at a time.
 */
export function HubItemsSection({ onCreate }: { onCreate: () => void }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const all = useTabCounters();
  const { numbers: channels, loading: channelsLoading } = useInboundClaims(InboundWebhooks, 0);

  const [tabId, setTabId] = useState(() => readPref(TAB_KEY) ?? hubAgentCounterGroup.id);
  const [view, setView] = useState<View>(() => (readPref(VIEW_KEY) === 'list' ? 'list' : 'grid'));
  const [counterKey, setCounterKey] = useState('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);

  const tabs = TABS.map((tab, i) => ({ tab, counters: all[i], total: all[i][0]?.items.length ?? 0 })).filter(
    ({ tab, total }) => !tab.hideWhenEmpty || total > 0,
  );
  const current = tabs.find(({ tab }) => tab.group.id === tabId) ?? tabs[0];
  const { group } = current.tab;
  const counter = current.counters.find((c) => c.key === counterKey) ?? current.counters[0];
  const rows = useQuickSearch(group, counter?.items ?? [], query);

  // Every change of what is listed starts again from the first page.
  const selectTab = (id: string) => {
    setTabId(id);
    setCounterKey('all');
    setQuery('');
    setShown(PAGE_SIZE);
    writePref(TAB_KEY, id);
  };
  const selectCounter = (key: string) => {
    setCounterKey(key);
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
            active={counters.find((c) => c.key === 'active')?.items.length}
            isLoading={!!counters[0]?.isLoading}
            selected={tab.group.id === group.id}
            onClick={() => selectTab(tab.group.id)}
            testId={`hub-tab-${tab.group.id}`}
          />
        ))}
        {/* Channels have their own screen; the tab opens it rather than a list here. */}
        <TabButton
          label={<Trans>Channels</Trans>}
          count={channels.length}
          isLoading={channelsLoading}
          selected={false}
          onClick={() => openInbound(navigation)}
          testId="hub-tab-channels"
        />
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
            {current.counters.length > 1 &&
              current.counters.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => selectCounter(c.key)}
                  className={cn(CHIP_CLASS, 'px-3 py-1', c.key === counter?.key && 'border-primary/50 bg-card')}
                  data-testid="hub-items-filter"
                  data-counter={c.key}
                >
                  <span className="text-muted-foreground group-hover:text-foreground">{c.label}</span>
                  <span className="tabular-nums text-foreground">{c.items.length}</span>
                </button>
              ))}
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

function ItemCard({ card, onOpen }: { card: AssetCard; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="hub-items-card"
    >
      <div className="flex w-full items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{card.title}</span>
        {card.status && (
          <Badge
            variant="outline"
            className={cn(
              'shrink-0 rounded-full border-transparent px-2 font-medium',
              card.status.active ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-muted-foreground',
            )}
          >
            {card.status.label}
          </Badge>
        )}
      </div>
      {card.description && <p className="line-clamp-2 text-sm text-muted-foreground">{card.description}</p>}
      {/* Interactive footer content (an issue's Fix) stops its own click, as it does in the table. */}
      {card.footer && (
        <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">{card.footer}</div>
      )}
    </div>
  );
}
