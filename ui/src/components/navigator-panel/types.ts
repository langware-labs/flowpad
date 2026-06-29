import type { ReactNode } from 'react';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { BrowseableRoot, ToolbarAction } from '@src/components/browseable-tree/types';
import type { ScopeFilter } from '@src/lib/scope-filter';

/**
 * Context-aware search for a navigator. When present, `NavigatorPanel` shows a
 * search icon in the header; activating it morphs the title row into a realtime
 * search input (with a settings popover + close) and renders backend FTS results
 * — of the menu's own entity types — in place of the list. The navigator only
 * declares *what* to search; the panel owns the entire search UX.
 */
export interface NavigatorSearchConfig {
  /** Entity/record types this menu lists — the search's context. Used both as
   *  the default type filter and as the multi-type fan-out set (e.g.
   *  `['claude_session','codex_session','copilot_session']` for Chats,
   *  `['markdown']` for Docs, `['workflow']` for Workflows). */
  recordTypes: string[];
  /** Scope filter to seed the search with (the navigator's current scope).
   *  Omitted → the panel uses the default project-derived scope. */
  scope?: ScopeFilter | null;
  /** Route a session result click through the live terminal dock (Chats).
   *  Mirrors `SpotlightProfile.routeViaTerminal`. */
  routeViaTerminal?: boolean;
  /** Input placeholder, e.g. "Search chats…". */
  placeholder?: string;
}

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
  /** Right-aligned control pinned in the title row itself (e.g. the scope
   *  filter icon bar). Shares the row's trailing slot with `toolbar`. This is
   *  the single canonical home for a navigator's scope filter. */
  headerRight?: ReactNode;
  /** Arbitrary control row under the title (e.g. a search box). */
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

  /** Optional context-aware search. When set, the panel renders a search icon
   *  in the header and owns the inline search experience. */
  search?: NavigatorSearchConfig;

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
