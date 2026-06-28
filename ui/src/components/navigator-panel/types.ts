import type { ReactNode } from 'react';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { BrowseableRoot, ToolbarAction } from '@src/components/browseable-tree/types';

/**
 * NavigatorDescriptor — what a view contributes to the shared left-menu slot
 * (Zone B). The view supplies data + intent; `NavigatorPanel` owns all chrome
 * (collapse, resize, persistence, header layout) and the row engine
 * (`BrowseableTree`).
 *
 * Invariants (mirrors BrowseableTree + CLAUDE.md URL-first rule):
 * - Selection is URL-first: a row click calls `onNavigate` (→ openDock) only;
 *   the active row derives from `activePointer`/`activeKey` (from currentDock).
 * - There is exactly one active item. Multi-select is intentionally unsupported.
 */
export interface NavigatorHeader {
  title?: string;
  /** Count pill rendered next to the title (e.g. number of workflows). */
  countBadge?: number;
  /** Arbitrary control row under the title (e.g. a scope filter bar). */
  filterBar?: ReactNode;
  /** Always-visible header actions (e.g. "+ New"). */
  toolbar?: ToolbarAction[];
}

export interface NavigatorWidth {
  default: number;
  min: number;
  max: number;
}

export interface NavigatorDescriptor {
  /** Stable id — persistence key (`navigator:<id>:collapsed|width`) + a11y. */
  id: string;

  // Row-engine fields — used by the default BrowseableTree body. Optional
  // because a `customBody` navigator (e.g. Triggers) drives its own rows.
  /** Top-level roots for the BrowseableTree row engine. */
  roots?: BrowseableRoot[];

  /** Whole-tree loading state (roots still fetching). */
  isLoading?: boolean;

  /** Optional header (title, count, filter bar, actions). */
  header?: NavigatorHeader;

  /** Active pointer (from currentDock/URL) — drives selection + auto-expand. */
  activePointer?: DockPointer | null;

  /** Optional URL-derived alternate selection key (typeid form). */
  activeKey?: string | null;

  /** Navigation callback — the ONLY state writer. Host supplies it (it may wrap
   *  openDock, e.g. Assets re-stamps the scope filter). */
  onNavigate?: (pointer: DockPointer) => void;

  /** Inject a context provider around the tree (e.g. AssetTypeCountsContext). */
  wrapTree?: (tree: ReactNode) => ReactNode;

  /** Escape hatch: render this instead of the BrowseableTree row engine, for
   *  lists too rich/irregular for the row model (e.g. the Triggers list with
   *  per-type sections, sub-scope grouping, and live interactive rows). The
   *  panel still owns collapse/resize/persistence + the header; the custom body
   *  owns its own rows. Selection must stay URL-first (openDock) like the tree. */
  customBody?: ReactNode;

  /** Resize bounds; defaults to 224/160/560. */
  width?: NavigatorWidth;

  /** Custom empty state when `roots` is empty. */
  emptyState?: ReactNode;
}
