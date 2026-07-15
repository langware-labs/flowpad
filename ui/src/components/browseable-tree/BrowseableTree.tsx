import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import { openBrowseable } from './open';
import type { Browseable, BrowseableDragData, BrowseableTreeProps, ToolbarAction } from './types';
import { useBrowseableTree } from './useBrowseableTree';
import {
  collectDroppedEntries,
  hasBrowseableDrag,
  hasExternalFilesDrag,
  readBrowseableDrag,
  writeBrowseableDrag,
} from './drag';
import { subscribeRefresh } from './refresh-store';
import { TreeSelectionContext, type TreeSelectionApi } from './useTreeSelection';
import { useOpenTabHashes } from '@src/tabs/useTabs';
import { RAIL_DIM_WHEN_CLOSED } from '@src/lib/utils';

/** Walk a root's currently-visible (expanded) subtree in render order,
 *  collecting the selectable rows. Powers Shift-range + Cmd/Ctrl+A. */
function collectVisibleSelectable(root: Browseable, tree: ReturnType<typeof useBrowseableTree>): Browseable[] {
  const out: Browseable[] = [];
  const walk = (node: Browseable) => {
    if (node.selectable && node.selectionKey) out.push(node);
    if (tree.isExpanded(node.id)) for (const c of tree.getChildren(node.id)) walk(c);
  };
  // Roots themselves aren't selectable; start from their visible children.
  if (tree.isExpanded(root.id)) for (const c of tree.getChildren(root.id)) walk(c);
  return out;
}

/**
 * Generic Notion-like tree menu.
 *
 * Invariants (mirrors the design doc):
 *  - Clicking a row with `pointer !== null` navigates (via `onNavigate`) —
 *    it does NOT expand; expansion belongs to the chevron. A pointer-less
 *    parent row still expands on click (header rows stay usable).
 *  - Double-clicking a row expands it as well — click+dblclick together =
 *    show in the body AND expand in the tree. (On an already-selected
 *    renamable row, double-click enters inline rename instead.)
 *  - Clicking a toolbar button runs a side effect; it never navigates.
 *  - Clicking the chevron toggles expansion; it does not navigate.
 *  - Selection is derived from `activePointer` — never stored locally.
 *  - Expansion is ephemeral (local Set<string>).
 *  - When `activePointer` changes, the first root that `ownsPointer` is
 *    asked for the ancestor chain and every ancestor is expanded.
 */
export function BrowseableTree(props: BrowseableTreeProps) {
  const { t } = useLingui();
  const {
    roots,
    activePointer,
    activeKey,
    header,
    onNavigate,
    isLoading,
    error,
    emptyState,
    className = '',
    persistKey,
    defaultExpandedIds,
  } = props;

  const tree = useBrowseableTree(roots, { persistKey, defaultExpandedIds });
  // Set of open-tab identities → rows backed by an open tab stay bright, the rest
  // dim (see BrowseableRow). Subscribed once here, passed down through the tree.
  const openTabHashes = useOpenTabHashes();
  const lastResolvedRef = useRef<string | null>(null);
  const [dragData, setDragData] = useState<BrowseableDragData | null>(null);

  // Multi-select (a second cursor, orthogonal to URL-first navigation). Null
  // when no provider wraps the tree (popover menu, or a navigator without a
  // bulkActions resolver) → the tree behaves exactly as before. Read via a ref
  // in the effects below so they key only on structure, not on the selection
  // api's identity (which changes on every selection mutation).
  const selection = useContext(TreeSelectionContext);
  const selectionRef = useRef<TreeSelectionApi | null>(selection);
  selectionRef.current = selection;

  // Keep the selection's per-root visible order in sync so Shift-range and
  // Cmd/Ctrl+A operate over what's actually on screen. Keyed on structure only
  // (roots + tree expansion/load state) — selection mutations don't change what's
  // visible, so they must not re-run this all-roots walk.
  useEffect(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    for (const root of roots) {
      sel.setVisibleOrder(root.id, collectVisibleSelectable(root, tree));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, tree.state]);

  // Clear selection when the set of roots changes identity (scope/filter change
  // — root ids carry the filter signature — or the type list changes). Mirrors
  // HistoryModal's de-select-on-change.
  const rootIdsKey = roots.map((r) => r.id).join('|');
  useEffect(() => {
    selectionRef.current?.clear();
  }, [rootIdsKey]);

  const handleNavigate = useCallback(
    (pointer: DockPointer) => {
      onNavigate?.(pointer);
    },
    [onNavigate],
  );

  // Subscribe to external refresh signals (e.g. asset deleted from a hover
  // toolbar). The adapter that emits the signal owns the node id and decides
  // which subtree to invalidate.
  useEffect(
    () =>
      subscribeRefresh((nodeId) => {
        void tree.invalidate(nodeId);
      }),
    [tree],
  );

  // Auto-expand ancestors for the active pointer. Dedupe by pointer value so
  // we don't re-walk on every render — but only mark as resolved once a leaf
  // was actually found, so we retry when `roots` populate later (e.g. async
  // adapter like useAssetTypes loads after initial render).
  useEffect(() => {
    if (!activePointer) return;
    const key = `${activePointer.viewType ?? ''}::${activePointer.pointer ?? ''}::${activeKey ?? ''}`;
    if (key === lastResolvedRef.current) return;
    void tree.expandParentsForPointer(activePointer).then((leaf) => {
      requestAnimationFrame(() => {
        // Prefer the keyed target: a typeid URL expands the type root (pathFor →
        // [root]) so the matching leaf renders, but it's keyed by vfs path, not
        // the URL's typeid. Find it by `data-selection-key`; fall back to the
        // pathFor leaf (the vfs case). Only mark resolved once a target is found
        // so a not-yet-rendered typeid leaf retries on the next children load.
        const el =
          (activeKey && document.querySelector(`[data-selection-key="${CSS.escape(activeKey)}"]`)) ||
          (leaf && document.querySelector(`[data-browseable-id="${CSS.escape(leaf.id)}"]`));
        if (!el) return;
        lastResolvedRef.current = key;
        el.scrollIntoView({ block: 'center' });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePointer, activeKey, tree.expandParentsForPointer]);

  if (isLoading) {
    return (
      <div className={`p-4 text-center text-xs text-muted-foreground ${className}`}>
        <Trans>Loading...</Trans>
      </div>
    );
  }

  if (error) {
    return <div className={`p-4 text-center text-xs text-destructive ${className}`}>{error}</div>;
  }

  if (roots.length === 0) {
    return (
      <div className={`p-4 text-center ${className}`}>
        {emptyState ?? (
          <p className="text-xs text-muted-foreground">
            <Trans>No items</Trans>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`flex h-full flex-col ${className}`} role="tree" aria-label={header?.title}>
      {header && (
        <div className="flex items-center gap-1 border-b p-1.5">
          <span className="text-xs font-medium text-muted-foreground">{header.title}</span>
          <div className="ml-auto flex items-center gap-0.5">
            {header.toolbar?.map((a) => (
              <ToolbarButton key={a.id} action={a} />
            ))}
            {header.extra}
          </div>
        </div>
      )}
      <div className="flex-1 space-y-0.5 overflow-auto p-1">
        {roots.map((root) => (
          <BrowseableRow
            key={root.id}
            node={root}
            level={0}
            rootId={root.id}
            tree={tree}
            selection={selection}
            activePointer={activePointer}
            activeKey={activeKey}
            openTabHashes={openTabHashes}
            onNavigate={handleNavigate}
            dragData={dragData}
            onDragStart={setDragData}
            onDragEnd={() => setDragData(null)}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  node: Browseable;
  level: number;
  /** Id of the top-level root this row lives under — the multi-select scope. */
  rootId: string;
  tree: ReturnType<typeof useBrowseableTree>;
  selection: TreeSelectionApi | null;
  activePointer: DockPointer | null;
  activeKey?: string | null;
  /** Open-tab identities (`pointer.tabHash`) → un-dimmed rows. */
  openTabHashes: Set<string>;
  onNavigate: (p: DockPointer) => void;
  dragData: BrowseableDragData | null;
  onDragStart: (data: BrowseableDragData) => void;
  onDragEnd: () => void;
}

function BrowseableRow({
  node,
  level,
  rootId,
  tree,
  selection,
  activePointer,
  activeKey,
  openTabHashes,
  onNavigate,
  dragData,
  onDragStart,
  onDragEnd,
}: RowProps) {
  const { t } = useLingui();
  const expanded = tree.isExpanded(node.id);
  const loadState = tree.getLoadState(node.id);
  const children = tree.getChildren(node.id);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isDropping, setIsDropping] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const canRename = !!node.onRename && !node.content;

  // Restored expansion (persistKey / defaultExpandedIds) marks nodes expanded
  // without the children fetch that interactive expand() runs — load on first
  // render in that state so restored layers aren't empty.
  useEffect(() => {
    if (expanded && loadState.status === 'idle' && node.listChildren) {
      void tree.loadChildren(node);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, loadState.status, node.id]);

  const isSelected = !!(
    // Stable-id match: a typeid URL (activeKey) selects this row even though its
    // `pointer` is the vfs form.
    (
      (node.selectionKey && activeKey && node.selectionKey === activeKey) ||
      // Pointer-string match: the original path (vfs leaf, list/folder roots, etc.).
      (node.pointer &&
        activePointer &&
        node.pointer.viewType === activePointer.viewType &&
        node.pointer.pointer === activePointer.pointer)
    )
  );

  // Dim openable rows that aren't currently open as a tab (and aren't the active
  // row, which is open by definition). Hover restores full brightness. Rows
  // without a pointer (headers/categories) are never dimmed.
  const hasOpenTab = !!(node.pointer?.tabHash && openTabHashes.has(node.pointer.tabHash));
  const dimmed = !!node.pointer && !isSelected && !hasOpenTab;

  const hasChildrenHint = node.hasChildren === true || (node.hasChildren === 'unknown' && !!node.listChildren);

  const canSelect = !!(selection && node.selectable && node.selectionKey);
  const multiSelected = canSelect && selection.isSelected(node.selectionKey);

  const handleRowClick = useCallback(
    (e: React.MouseEvent) => {
      // Inline rename in progress — a click commits via the input's own handlers;
      // never navigate/toggle underneath it.
      if (editing) return;

      // Multi-select gestures take precedence on selectable rows. A modifier
      // click only mutates the selection — it never navigates or toggles
      // expansion. A plain click clears the set + primes the range anchor, then
      // falls through to the normal navigate/expand behavior below.
      if (canSelect) {
        // Cmd (mac) or Ctrl (win/linux) toggles; matches the modifier convention
        // used across the app's keyboard handlers.
        const mod = e.metaKey || e.ctrlKey;
        if (mod || e.shiftKey) {
          e.preventDefault();
          if (e.shiftKey) selection.selectRange(node, rootId);
          else selection.toggle(node, rootId);
          return;
        }
        selection.anchorAndClear(node, rootId);
      }

      // Label click NAVIGATES only — expansion belongs to the chevron (or a
      // double-click). A pointer-less parent still expands on click so header
      // rows (pointer: null) stay usable.
      if (!openBrowseable(node, onNavigate) && hasChildrenHint) {
        void tree.toggleExpand(node);
      }
    },
    [editing, canSelect, selection, rootId, hasChildrenHint, node, tree, onNavigate],
  );

  // Double-click: inline rename on a *selected* renamable row; otherwise
  // expand — combined with the single click that already fired, a double
  // click both shows the content (right pane) AND expands (left pane).
  const handleDoubleClick = useCallback(() => {
    if (canRename && isSelected) {
      setDraft(node.label);
      setEditing(true);
      return;
    }
    if (hasChildrenHint) {
      void tree.toggleExpand(node);
    }
  }, [canRename, isSelected, node, hasChildrenHint, tree]);

  const commitRename = useCallback(async () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== node.label) await node.onRename?.(next);
  }, [draft, node]);

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void tree.toggleExpand(node);
    },
    [node, tree],
  );

  // Intra-tree drags carry the full payload in lifted state → full canDrop
  // check during dragover. Foreign drags (started in another Browseable
  // surface, e.g. the desktop grid) only expose the MIME type during dragover
  // (HTML5 hides the body pre-drop) — accept optimistically on MIME presence
  // and run the full canDrop check at drop time via readBrowseableDrag.
  const canAcceptDrop = !!(dragData && node.onDrop && (!node.canDrop || node.canDrop(dragData)));
  // Space reserved (on hover/focus only) so the label clears the
  // absolutely-positioned compact toolbar when it appears
  // (h-5/w-5 buttons + gap-0.5 + px-0.5 + right-1). At rest the toolbar is
  // hidden, so the label keeps its full width.
  //
  // Badge rows reserve the space PERMANENTLY (see the padding class below) —
  // and always at least TWO button slots, so count badges line up across
  // sibling rows whose toolbars differ (refresh-only vs refresh+add).
  const toolbarSpace =
    node.toolbar && node.toolbar.length > 0 ? Math.max(node.toolbar.length, node.badge ? 2 : 0) * 22 + 6 : 0;

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (!node.dragData) return;
      e.stopPropagation();
      writeBrowseableDrag(e, node.dragData);
      onDragStart(node.dragData);
    },
    [node.dragData, onDragStart],
  );

  const handleDragEnd = useCallback(() => {
    setIsDropTarget(false);
    onDragEnd();
  }, [onDragEnd]);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      const foreign = !dragData && !!node.onDrop && hasBrowseableDrag(e);
      // OS files from outside the app (only the 'Files' type is visible
      // pre-drop) — a copy into the node, not a move within the tree.
      const external = !dragData && !!node.onExternalFilesDrop && hasExternalFilesDrag(e);
      if (!canAcceptDrop && !foreign && !external) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = external && !canAcceptDrop && !foreign ? 'copy' : 'move';
      setIsDropTarget(true);
    },
    [canAcceptDrop, dragData, node.onDrop, node.onExternalFilesDrop],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDropTarget(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      // Payload: lifted state for intra-tree drags, MIME body for foreign ones.
      const payload = dragData ?? readBrowseableDrag(e);
      if (!payload) {
        // No Browseable payload → an external OS drop. Entry handles expire
        // with the event, so collect synchronously before any await.
        if (!node.onExternalFilesDrop || !hasExternalFilesDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDropTarget(false);
        setIsDropping(true);
        const collecting = collectDroppedEntries(e.dataTransfer);
        try {
          const entries = await collecting;
          if (entries.length) await node.onExternalFilesDrop(entries);
        } finally {
          setIsDropping(false);
          onDragEnd();
        }
        return;
      }
      if (!node.onDrop) return;
      if (node.canDrop && !node.canDrop(payload)) {
        setIsDropTarget(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setIsDropTarget(false);
      setIsDropping(true);
      try {
        await node.onDrop(payload);
      } finally {
        setIsDropping(false);
        onDragEnd();
      }
    },
    [dragData, node, onDragEnd],
  );

  return (
    <div data-browseable-id={node.id} data-selection-key={node.selectionKey}>
      <div
        className={`group relative flex items-center gap-1 rounded-md p-1.5 text-xs transition-[color,background-color,border-color,opacity] ${
          isSelected ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted'
        } ${dimmed ? RAIL_DIM_WHEN_CLOSED : ''} ${
          // Multi-select ring — distinct from, and composable with, the active
          // (bg-accent) fill: a row can be both the open editor and selected.
          multiSelected ? 'ring-2 ring-inset ring-primary' : ''
        } ${node.pointer || canSelect ? 'cursor-pointer' : 'cursor-default'} ${node.dragData ? 'active:cursor-grabbing' : ''} ${
          isDropTarget ? 'bg-primary/10 ring-1 ring-primary/40' : ''
        } ${isDropping ? 'opacity-60' : ''} ${node.rowClassName ?? ''}`}
        style={{ marginLeft: `${level * 14}px` }}
        role="treeitem"
        aria-level={level + 1}
        aria-selected={isSelected}
        data-multi-selected={multiSelected || undefined}
        aria-expanded={hasChildrenHint ? expanded : undefined}
        draggable={!!node.dragData}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => {
          void handleDrop(e);
        }}
      >
        <div
          className={`flex min-w-0 flex-1 items-center gap-1 overflow-hidden ${
            toolbarSpace
              ? node.badge
                ? // A badge sits right-aligned in this zone — reserve the
                  // hover-toolbar slot PERMANENTLY so the badge doesn't jump
                  // left when the toolbar fades in (git pills stay put while
                  // the remove button appears beside them).
                  'pr-[var(--toolbar-space)]'
                : 'transition-[padding] group-focus-within:pr-[var(--toolbar-space)] group-hover:pr-[var(--toolbar-space)]'
              : ''
          }`}
          style={toolbarSpace ? ({ '--toolbar-space': `${toolbarSpace}px` } as React.CSSProperties) : undefined}
        >
          {hasChildrenHint ? (
            <button
              type="button"
              onClick={handleChevronClick}
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
              title={expanded ? t`Collapse` : t`Expand`}
              aria-label={expanded ? t`Collapse` : t`Expand`}
              data-testid={`browseable-chevron-${node.id}`}
            >
              {loadState.status === 'loading' ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : expanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </button>
          ) : (
            <div className="w-4 flex-shrink-0" />
          )}

          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
            onClick={handleRowClick}
            onDoubleClick={handleDoubleClick}
          >
            {node.content ? (
              node.content
            ) : editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void commitRename();
                  else if (e.key === 'Escape') setEditing(false);
                }}
                onBlur={() => void commitRename()}
                className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                data-testid={`browseable-rename-${node.id}`}
              />
            ) : (
              <>
                {node.icon}
                <span className="min-w-0 flex-1 truncate" title={node.label}>
                  {node.label}
                </span>
                {node.badge && <div className="flex-shrink-0">{node.badge}</div>}
              </>
            )}
          </div>
        </div>

        {node.toolbar && node.toolbar.length > 0 && (
          <div className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-background/80 px-0.5 opacity-0 shadow-sm backdrop-blur group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
            {node.toolbar.map((a) => (
              <ToolbarButton key={a.id} action={a} compact />
            ))}
          </div>
        )}
      </div>

      {expanded && (
        <div className="space-y-0.5">
          {loadState.status === 'loading' && children.length === 0 && (
            <div className="p-1 text-xs text-muted-foreground" style={{ marginLeft: `${(level + 1) * 14}px` }}>
              <Trans>Loading…</Trans>
            </div>
          )}
          {loadState.status === 'error' && (
            <div className="p-1 text-xs text-destructive" style={{ marginLeft: `${(level + 1) * 14}px` }}>
              {loadState.message || t`Failed to load`}
            </div>
          )}
          {loadState.status === 'ready' && children.length === 0 && (
            <div className="p-1 text-xs text-muted-foreground" style={{ marginLeft: `${(level + 1) * 14}px` }}>
              <Trans>Empty</Trans>
            </div>
          )}
          {children.map((child) => (
            <BrowseableRow
              key={child.id}
              node={child}
              level={level + 1}
              rootId={rootId}
              tree={tree}
              selection={selection}
              activePointer={activePointer}
              activeKey={activeKey}
              openTabHashes={openTabHashes}
              onNavigate={onNavigate}
              dragData={dragData}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolbarButton({ action, compact }: { action: ToolbarAction; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const showBusy = action.showBusyIndicator ?? true;

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const result = action.run();
      if (result instanceof Promise) {
        if (showBusy) setBusy(true);
        try {
          await result;
        } finally {
          if (showBusy) setBusy(false);
        }
      }
    },
    [action, showBusy],
  );

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={compact ? 'h-5 w-5' : 'h-6 w-6'}
      onClick={(e) => void handleClick(e)}
      disabled={busy}
      title={action.label}
      aria-label={action.label}
      data-testid={`browseable-toolbar-${action.id}`}
    >
      {busy && showBusy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <span className="[&>svg]:h-3 [&>svg]:w-3">{action.icon}</span>
      )}
    </Button>
  );
}
