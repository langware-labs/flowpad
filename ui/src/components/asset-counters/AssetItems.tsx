import { Trans, useLingui } from '@lingui/react/macro';
import { Input } from '@src/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { cn } from '@src/lib/utils';
import { Search, X } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { matchesQuickSearch, quickSearchTerms } from './quick-search';
import type { AssetCounterGroup } from './types';

/**
 * The pieces every view over a counter group shares — the asset-list screen and
 * the hub home's items section: the quick-search filter, its input, the table,
 * and the green/grey "is it live" dot.
 */

/** `items` narrowed to those matching `query`. Each item is lower-cased once per list, not per keystroke. */
export function useQuickSearch<T>(group: AssetCounterGroup<T>, items: T[], query: string): T[] {
  const indexed = useMemo(
    () => items.map((item) => ({ item, haystack: group.searchText(item).toLowerCase() })),
    [items, group],
  );
  return useMemo(() => {
    const terms = quickSearchTerms(query);
    return indexed.filter(({ haystack }) => matchesQuickSearch(haystack, terms)).map(({ item }) => item);
  }, [indexed, query]);
}

export function QuickSearchInput({
  value,
  onChange,
  className,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  testId?: string;
}) {
  const { t } = useLingui();
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onChange('')}
        placeholder={t`Quick search`}
        aria-label={t`Quick search`}
        className="pl-9 pr-9"
        data-testid={testId}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={t`Clear search`}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** A group's rows as its table; a row click opens the item. `empty` fills the body when there are no rows. */
export function CounterTable<T>({
  group,
  rows,
  onOpen,
  empty,
  rowTestId,
}: {
  group: AssetCounterGroup<T>;
  rows: T[];
  onOpen: (item: T) => void;
  empty?: ReactNode;
  rowTestId: string;
}) {
  return (
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
            onClick={() => onOpen(item)}
            className="cursor-pointer"
            data-testid={rowTestId}
          >
            {group.columns.map((column) => (
              <TableCell key={column.key} className={column.className}>
                {column.cell(item)}
              </TableCell>
            ))}
          </TableRow>
        ))}
        {rows.length === 0 && empty && (
          <TableRow>
            <TableCell colSpan={group.columns.length} className="py-10 text-center text-muted-foreground">
              {empty}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** The green (live) / grey (not) dot. */
export function LiveDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn('inline-block h-1.5 w-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
    />
  );
}

/** A status label with its live dot in front. */
export function StatusDot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <LiveDot active={active} />
      {children}
    </span>
  );
}

/** "No matches" vs. "nothing yet", for an empty filtered list. */
export function NoRows({ hasItems, query }: { hasItems: boolean; query: string }) {
  return hasItems ? <Trans>No matches for “{query}”.</Trans> : <Trans>Nothing here yet.</Trans>;
}
