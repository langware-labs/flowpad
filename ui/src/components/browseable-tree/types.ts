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

/** One OS file from an external drag-drop, with its path relative to the drop
 *  (posix, includes the file name — nested when a whole folder was dropped). */
export interface DroppedFileEntry {
  file: File;
  relPath: string;
}

/**
 * Browseable — generic node in a tree menu.
 *
 * A Browseable represents anything that can be rendered as a row in a tree: a
 * category root, a folder, a document, a session, etc. The protocol is shared
 * across Wiki, Collaboration, and any other view that needs a tree menu.
 *
 * Design invariants:
 * - Click on a row resolves as `pointer ?? activate`. `pointer` is the
 *   preferred pure form (URL-first: click == navigate to the pointer, never a
 *   side effect); `activate` is the documented imperative fallback for
 *   entities whose navigation requires async lookups or side effects (e.g.
 *   resolving a session by worker id first). Neither ⇒ non-actionable row.
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

  /** Optional topic tag (see ui/src/topics): the row renders `data-topic`, so
   *  it is highlightable by journeys/wiki links and click-observable on the
   *  EventBus — declaratively, with no per-adapter DOM wiring. */
  topic?: string;

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
   *  (clicking just toggles the chevron) — unless `activate` is set. */
  pointer: DockPointer | null;

  /** Imperative activation fallback for nodes whose navigation cannot be
   *  expressed as a pure DockPointer (async entity resolution / side effects).
   *  Renderers resolve a click as `pointer ?? activate`. Prefer `pointer`
   *  wherever possible — it keeps navigation URL-first and selectable. */
  activate?: () => void | Promise<void>;

  /** Fired when the row is OPENED — from BOTH the `pointer` and `activate`
   *  arms, so a usage stamp can't miss the (majority) pointer case. Never
   *  fires for a row that opened nothing (neither arm set). Whether a
   *  CONTAINER can open is the renderer's call, not this contract's: a click
   *  on one expands, and the grid and tree order that against the pointer arm
   *  differently. Both go through `openBrowseable` (./open.ts), which owns the
   *  arm resolution and fires this AFTER dispatch, so a throw here cannot
   *  break the navigation.
   *
   *  Side effect ONLY — a usage stamp on the underlying entity (e.g. the
   *  favorites open-counter). Never navigate, never gate navigation, never
   *  write view state. */
  onOpen?: () => void;

  /** Optional hover tooltip content (e.g. a live entity summary). Rendered by
   *  both the desktop grid and the tree. In the tree it doubles as the hover
   *  PREVIEW: hovering a row shows it without opening anything. */
  tooltip?: ReactNode;

  /** Optional stable alternate identity for *selection* matching, used when the
   *  active pointer addresses this row by a different serialization than its
   *  `pointer` (e.g. an `editor/<t>/typeid/<id>` URL vs a vfs-path leaf). The
   *  tree compares it (as a string) against its `activeKey` prop, in addition to
   *  the pointer-string match. Only set where a row has a stable id (asset
   *  leaves set their `<type>-<uuid>` typeid); other rows leave it undefined.
   *
   *  Doubles as the membership key for *multi-select* (see `selectable`). */
  selectionKey?: string;

  /** Multi-select: when true (and `selectionKey` is set), this row participates
   *  in OS-native multi-selection (Cmd/Ctrl-click toggle, Shift-click range).
   *  Default off → the row behaves exactly as before (plain click navigates).
   *  Independent of the URL-first *navigation* cursor; selection is ephemeral
   *  local state, never persisted or written to the URL. */
  selectable?: boolean;

  /** Multi-select: the entity `type_name` (e.g. `skill`, `agent`, `markdown`) or
   *  an adapter discriminator (e.g. `file`). A `bulkActions` resolver branches the
   *  selection toolbar on the set of selected types. */
  selectionType?: string;

  /** Multi-select: how to delete this row in a bulk operation, plus the node id
   *  to refresh afterward. The adapter that builds the row owns the delete (it
   *  already has the endpoint / path in scope); the selection toolbar runs each
   *  selected row's `run` under a single confirm, then refreshes the distinct
   *  `refreshId`s. Keeps delete knowledge with the adapter rather than re-derived
   *  (endpoint vs compute-node, path shape) in the toolbar resolver. */
  bulkDelete?: { run: () => Promise<void>; refreshId: string };

  /** Inline hover actions. Side effects only. */
  toolbar?: ToolbarAction[];

  /** Internal tree drag payload. When present, the row can be dragged. */
  dragData?: BrowseableDragData;

  /** Return true when this row can accept the currently-dragged row. */
  canDrop?: (dragData: BrowseableDragData) => boolean;

  /** Side effect for a successful drop. */
  onDrop?: (dragData: BrowseableDragData) => void | Promise<void>;

  /** Accept OS files/folders dropped from outside the app. Entries carry the
   *  drop-relative path (`relPath`, posix, includes the file name) so a dropped
   *  directory keeps its structure. Distinct from `onDrop`, which handles the
   *  intra-app Browseable payload. */
  onExternalFilesDrop?: (entries: DroppedFileEntry[]) => void | Promise<void>;

  /** Container-owned manual ordering of children: splice `dragId` into the
   *  gap next to the anchor sibling. Renderers that support reordering (the
   *  desktop grid's edge drop zones) call this; the anchor ids are siblings
   *  within THIS container. */
  reorderChildren?: (dragId: string, anchor: { afterId?: string; beforeId?: string }) => void | Promise<void>;
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

  /** Dwell (ms) before hovering a row expands it — menu mode. Undefined (the
   *  default) schedules nothing, so ordinary navigators never expand on hover.
   *  Hover only ever EXPANDS; collapse stays on the chevron/click, and an
   *  explicit collapse suppresses hover until the pointer leaves the row. */
  hoverExpandMs?: number;

  /** Rendered as the last row of EVERY level: once at the root ('') and once at
   *  the end of each expanded folder's children (its id). Its use is a build-
   *  as-you-browse toolbar — "add into THIS level" — so the parent id is handed
   *  in. Undefined ⇒ no footer, unchanged for ordinary navigators. */
  levelFooter?: (parentId: string) => ReactNode;

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
