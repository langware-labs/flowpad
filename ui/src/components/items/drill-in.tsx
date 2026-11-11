import { createContext, type ReactNode, useContext } from 'react';

/** A drill-in from a card: the list of `type` (a group's `type`), narrowed by `test`, under `label`'s breadcrumb. */
export interface DrillIn {
  /** The `group.type` of the list to open. */
  type: string;
  /** Whose list it is (the agent's name) — the breadcrumb's middle step. */
  label: ReactNode;
  // Groups list items of different types; each test is written for its own group's items.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  test: (item: any) => boolean;
}

export interface HomeItems {
  drillIn: (d: DrillIn) => void;
  /** Every item a group of `type` lists (its widest counter), already fetched by the home. */
  itemsOf: (type: string) => unknown[];
}

export const HomeItemsContext = createContext<HomeItems | null>(null);

/** Opens a drill-in on the home's items; null outside an `ItemsSection`. */
export function useDrillIn(): ((d: DrillIn) => void) | null {
  return useContext(HomeItemsContext)?.drillIn ?? null;
}

/** The home's items of a group `type`, without a new fetch; null outside an `ItemsSection`. */
export function useHomeItems<T>(type: string): T[] | null {
  const ctx = useContext(HomeItemsContext);
  return ctx ? (ctx.itemsOf(type) as T[]) : null;
}
