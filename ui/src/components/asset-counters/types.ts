import type { IDockPointer } from '@sdk';
import type { ReactNode } from 'react';
import type { AxisOption } from './axes';
import type { ItemCardValue } from '@src/components/items/ItemCard';
import type { ItemRole } from '@src/components/items/role';

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
  /** The scope and status this counter is the cross of (`axes.tsx`). Absent → that axis is not offered. */
  scope?: AxisOption;
  status?: AxisOption;
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
  itemPointer: (item: T) => IDockPointer | null;
  /** What the table's quick search matches against. */
  searchText: (item: T) => string;
  /** How one item reads as a card (the hub home grid). Absent → the group has no card view. */
  card?: (item: T) => AssetCard;
  /** The signed-in person's role on the item — what the card's chip and the Mine / Shared filter read. */
  role?: (item: T) => ItemRole | undefined;
}

/** One item as a card — the shared item value (`components/items/ItemCard.tsx`). */
export type AssetCard = ItemCardValue;
