import type { IDockPointer } from '@sdk';
import type { ReactNode } from 'react';

/**
 * One counter's value: the LIST behind the number. The home box shows
 * `items.length` and the table renders `items`, so the two can never disagree.
 */
export interface AssetCounter<T> {
  key: string;
  label: ReactNode;
  /** One line under the table title saying what this number counts. */
  description: ReactNode;
  items: T[];
  isLoading: boolean;
}

export interface AssetColumn<T> {
  key: string;
  header: ReactNode;
  cell: (item: T) => ReactNode;
  className?: string;
}

/**
 * A family of counters over one asset type — the extension seam. A new asset
 * type (or a new cut of an existing one) is a new group, or a new counter in
 * `useCounters`, registered in `registry.ts`; the home row and the table view
 * are generic over it. The heading comes from the type registry via `type`.
 *
 * `useCounters` is ONE hook returning every counter, so callers never call a
 * hook per counter in a loop or per URL value.
 */
export interface AssetCounterGroup<T> {
  id: string;
  type: string;
  useCounters: () => AssetCounter<T>[];
  columns: AssetColumn<T>[];
  itemKey: (item: T) => string;
  /** Where a row click navigates. */
  itemPointer: (item: T) => IDockPointer;
  /** What the table's quick search matches against. */
  searchText: (item: T) => string;
}
