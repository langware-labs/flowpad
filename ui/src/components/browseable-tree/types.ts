import type { ReactNode } from 'react';
import type { DockPointer } from '@src/navigation/DockPointer';

export interface BrowseableDragData {
  /** Adapter-specific discriminator. */
  kind: string;
  /** Stable id of the dragged row. */
  id: string;
  /** Human-readable label used for drag feedback and validation messages. */
  label: string;
  /** Adapter-specific payload. Keep this JSON-serializable. */
  [key: string]: unknown;
}

/**
 * Browseable — generic node in a tree menu.
 *
 * A Browseable represents anything that can be rendered as a row in a tree: a
 * category root, a folder, a document, a session, etc. The protocol is shared
 * across Wiki, Collaboration, and any other view that needs a tree menu.
 *
 * Design invariants:
 * - Click on a row == navigate to `pointer`. Never a side effect.
 * - Toolbar actions are explicitly for side effects (scan, new, delete).
 *   Never navigation.
 * - Selection is derived from the tree's `activePointer` prop, not stored.
 * - Expansion is ephemeral local state in the tree component.
 */
export interface Browseable {
  /** Stable id. Used as React key and as the ancestor-resolution token. Must
   *  be unique within a single tree. */
  id: string;

  /** Discriminator for adapters/debugging. Conventional values: "root",
   *  "asset-type", "asset", "session", "folder". */
  kind: string;

  /** Label rendered on the row. */
  label: string;

  /** Optional icon node. */
  icon?: ReactNode;

  /** Optional trailing content (count chips, status dots, time-ago labels). */
  badge?: ReactNode;

  /** Optional extra classes applied to the row container. Lets an adapter
   *  de-emphasize a row (e.g. an out-of-active-project chat row uses
   *  `opacity-50 hover:opacity-100`). Cosmetic only — never carries behavior. */
  rowClassName?: string;

  /** Optional full-row body that replaces the default `icon | label | badge`
   *  zone. Use for rich, multi-line rows (e.g. a trigger showing scope chip +
   *  name + type-specific metadata lines). When set, `label`/`icon`/`badge` are
   *  ignored for rendering (but `label` is still used for the drag/aria text).
   *  The chevron, toolbar, and selection styling are still provided by the row. */
  content?: ReactNode;

  /** When set, the row supports inline rename: double-clicking the row while it
   *  is selected swaps the label for a text input. Commit on Enter/blur, cancel
   *  on Escape. Ignored when `content` is set (rich rows manage their own
   *  editing). The side effect (persisting the new name) is the adapter's. */
  onRename?: (newName: string) => void | Promise<void>;

  /** Tri-state hint so the chevron can show before children are loaded.
   *  - `true`: children exist, load on expand
   *  - `false`: leaf, no chevron
   *  - `'unknown'`: show a chevron optimistically; resolve on first expand */
  hasChildren: boolean | 'unknown';

  /** Lazy loader; called at most once per expand. Cached by `id` in the tree.
   *  When called with `{ refresh: true }`, the adapter MUST bypass any caches
   *  it controls (e.g. fsStore's browseCache) so the result reflects fresh
   *  on-disk state. The tree uses this on deep-link auto-expand when the
   *  target leaf is missing from the parent's previously-loaded children. */
  listChildren?: (opts?: { refresh?: boolean }) => Promise<Browseable[]>;

  /** Click == navigate to this pointer. `null` means header-only row
   *  (clicking just toggles the chevron). */
  pointer: DockPointer | null;

  /** Optional stable alternate identity for *selection* matching, used when the
   *  active pointer addresses this row by a different serialization than its
   *  `pointer` (e.g. an `editor/<t>/typeid/<id>` URL vs a vfs-path leaf). The
   *  tree compares it (as a string) against its `activeKey` prop, in addition to
   *  the pointer-string match. Only set where a row has a stable id (asset
   *  leaves set their `<type>-<uuid>` typeid); other rows leave it undefined. */
  selectionKey?: string;

  /** Inline hover actions. Side effects only. */
  toolbar?: ToolbarAction[];

  /** Internal tree drag payload. When present, the row can be dragged. */
  dragData?: BrowseableDragData;

  /** Return true when this row can accept the currently-dragged row. */
  canDrop?: (dragData: BrowseableDragData) => boolean;

  /** Side effect for a successful drop. */
  onDrop?: (dragData: BrowseableDragData) => void | Promise<void>;
}

/**
 * A root Browseable. Roots own a subtree and know how to resolve a pointer
 * back to a chain of descendants (for deep-link auto-expand).
 */
export interface BrowseableRoot extends Browseable {
  kind: 'root';

  /** Does this root own the given pointer? First truthy wins during
   *  auto-expand. */
  ownsPointer: (pointer: DockPointer) => boolean;

  /**
   * Resolve the chain from this root down to the pointer's target, loading
   * lazily along the way. The returned chain always starts with the root
   * itself and ends with the leaf. If only the root matches, returns `[root]`.
   *
   * Called whenever `activePointer` changes; powers deep-link auto-expand.
   */
  pathFor: (pointer: DockPointer) => Promise<Browseable[]>;
}

/**
 * Inline hover action rendered to the right of a row.
 */
export interface ToolbarAction {
  /** Stable id (React key). */
  id: string;

  /** Icon component/node. */
  icon: ReactNode;

  /** Tooltip text and aria-label. */
  label: string;

  /** Called when the button is clicked. Explicitly a side effect — if you
   *  want to navigate, use the row's `pointer` instead. */
  run: () => void | Promise<void>;

  /** When to show the button. Default: `'hover'`. */
  visibleWhen?: 'hover' | 'always' | 'selected';

  /** Optional busy indicator while `run()` is pending. Defaults to true. */
  showBusyIndicator?: boolean;
}

/**
 * Props for the base-menu toolbar at the top of the tree.
 */
export interface BrowseableTreeHeader {
  title: string;
  toolbar?: ToolbarAction[];
  /** Optional extra content rendered to the right of the toolbar. */
  extra?: ReactNode;
}

/**
 * Props for the `<BrowseableTree>` component.
 */
export interface BrowseableTreeProps {
  /** Top-level roots. */
  roots: BrowseableRoot[];

  /** The currently-active pointer (from URL). Drives both row selection and
   *  ancestor auto-expand. */
  activePointer: DockPointer | null;

  /** Optional URL-derived alternate selection key (e.g. the active entity's
   *  `<type>-<uuid>` typeid when the URL addresses an asset by typeid). A row is
   *  selected when its `selectionKey` equals this, in addition to the
   *  pointer-string match — so a typeid URL selects a vfs-pointer leaf. Stays
   *  URL-derived (not from context). Null/undefined ⇒ pointer-string match only. */
  activeKey?: string | null;

  /** Optional header with title + base-menu toolbar. */
  header?: BrowseableTreeHeader;

  /** Navigation callback. Called when a row with a non-null pointer is
   *  clicked. Default (in production): `NavigationActions.openDock`. */
  onNavigate?: (pointer: DockPointer) => void;

  /** Loading state for the whole tree (e.g. roots are still fetching). */
  isLoading?: boolean;

  /** Error message for the whole tree. */
  error?: string | null;

  /** Custom empty state rendered when `roots` is empty. */
  emptyState?: ReactNode;

  /** Extra class name on the outer container. */
  className?: string;

  /** localStorage key persisting the expanded-ids set — see `useBrowseableTree`. */
  persistKey?: string;

  /** Node ids expanded when no persisted state exists (e.g. the root id). */
  defaultExpandedIds?: string[];
}
