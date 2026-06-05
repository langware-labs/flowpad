import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import type { Browseable, BrowseableDragData, BrowseableTreeProps, ToolbarAction } from './types';
import { useBrowseableTree } from './useBrowseableTree';
import { subscribeRefresh } from './refresh-store';

/**
 * Generic Notion-like tree menu.
 *
 * Invariants (mirrors the design doc):
 *  - Clicking a row with `pointer !== null` navigates (via `onNavigate`).
 *  - Clicking a toolbar button runs a side effect; it never navigates.
 *  - Clicking the chevron toggles expansion; it does not navigate.
 *  - Selection is derived from `activePointer` — never stored locally.
 *  - Expansion is ephemeral (local Set<string>).
 *  - When `activePointer` changes, the first root that `ownsPointer` is
 *    asked for the ancestor chain and every ancestor is expanded.
 */
export function BrowseableTree(props: BrowseableTreeProps) {
  const {
    roots,
    activePointer,
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
  const lastResolvedRef = useRef<string | null>(null);
  const [dragData, setDragData] = useState<BrowseableDragData | null>(null);

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
    const key = `${activePointer.viewType ?? ''}::${activePointer.pointer ?? ''}`;
    if (key === lastResolvedRef.current) return;
    void tree.expandParentsForPointer(activePointer).then((leaf) => {
      if (!leaf) return;
      lastResolvedRef.current = key;
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-browseable-id="${CSS.escape(leaf.id)}"]`);
        el?.scrollIntoView({ block: 'center' });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePointer, tree.expandParentsForPointer]);

  if (isLoading) {
    return <div className={`p-4 text-center text-xs text-muted-foreground ${className}`}>Loading...</div>;
  }

  if (error) {
    return <div className={`p-4 text-center text-xs text-destructive ${className}`}>{error}</div>;
  }

  if (roots.length === 0) {
    return (
      <div className={`p-4 text-center ${className}`}>
        {emptyState ?? <p className="text-xs text-muted-foreground">No items</p>}
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
            tree={tree}
            activePointer={activePointer}
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
  tree: ReturnType<typeof useBrowseableTree>;
  activePointer: DockPointer | null;
  onNavigate: (p: DockPointer) => void;
  dragData: BrowseableDragData | null;
  onDragStart: (data: BrowseableDragData) => void;
  onDragEnd: () => void;
}

function BrowseableRow({ node, level, tree, activePointer, onNavigate, dragData, onDragStart, onDragEnd }: RowProps) {
  const expanded = tree.isExpanded(node.id);
  const loadState = tree.getLoadState(node.id);
  const children = tree.getChildren(node.id);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isDropping, setIsDropping] = useState(false);

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
    node.pointer &&
    activePointer &&
    node.pointer.viewType === activePointer.viewType &&
    node.pointer.pointer === activePointer.pointer
  );

  const hasChildrenHint = node.hasChildren === true || (node.hasChildren === 'unknown' && !!node.listChildren);

  const handleRowClick = useCallback(() => {
    // Toggle expand on the row click for nodes that have children AND
    // navigate if the node has a pointer. Matches Notion's behavior where
    // clicking a page both navigates AND expands.
    if (hasChildrenHint) {
      void tree.toggleExpand(node);
    }
    if (node.pointer) {
      onNavigate(node.pointer);
    }
  }, [hasChildrenHint, node, tree, onNavigate]);

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void tree.toggleExpand(node);
    },
    [node, tree],
  );

  const canAcceptDrop = !!(dragData && node.onDrop && (!node.canDrop || node.canDrop(dragData)));

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (!node.dragData) return;
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-flowpad-browseable', JSON.stringify(node.dragData));
      e.dataTransfer.setData('text/plain', node.label);
      onDragStart(node.dragData);
    },
    [node.dragData, node.label, onDragStart],
  );

  const handleDragEnd = useCallback(() => {
    setIsDropTarget(false);
    onDragEnd();
  }, [onDragEnd]);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!canAcceptDrop) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setIsDropTarget(true);
    },
    [canAcceptDrop],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDropTarget(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!canAcceptDrop || !dragData || !node.onDrop) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDropTarget(false);
      setIsDropping(true);
      try {
        await node.onDrop(dragData);
      } finally {
        setIsDropping(false);
        onDragEnd();
      }
    },
    [canAcceptDrop, dragData, node, onDragEnd],
  );

  return (
    <div data-browseable-id={node.id}>
      <div
        className={`group relative flex items-center gap-1 rounded-md p-1.5 text-xs transition-colors ${
          isSelected ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted'
        } ${node.pointer ? 'cursor-pointer' : 'cursor-default'} ${node.dragData ? 'active:cursor-grabbing' : ''} ${
          isDropTarget ? 'bg-primary/10 ring-1 ring-primary/40' : ''
        } ${isDropping ? 'opacity-60' : ''}`}
        style={{ marginLeft: `${level * 14}px` }}
        role="treeitem"
        aria-level={level + 1}
        aria-selected={isSelected}
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
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {hasChildrenHint ? (
            <button
              type="button"
              onClick={handleChevronClick}
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
              title={expanded ? 'Collapse' : 'Expand'}
              aria-label={expanded ? 'Collapse' : 'Expand'}
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

          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden" onClick={handleRowClick}>
            {node.icon}
            <span className="min-w-0 flex-1 truncate" title={node.label}>
              {node.label}
            </span>
            {node.badge && <div className="flex-shrink-0">{node.badge}</div>}
          </div>
        </div>

        {node.toolbar && node.toolbar.length > 0 && (
          <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-background/80 px-0.5 opacity-0 shadow-sm backdrop-blur group-hover:opacity-100">
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
              Loading…
            </div>
          )}
          {loadState.status === 'error' && (
            <div className="p-1 text-xs text-destructive" style={{ marginLeft: `${(level + 1) * 14}px` }}>
              {loadState.message || 'Failed to load'}
            </div>
          )}
          {loadState.status === 'ready' && children.length === 0 && (
            <div className="p-1 text-xs text-muted-foreground" style={{ marginLeft: `${(level + 1) * 14}px` }}>
              Empty
            </div>
          )}
          {children.map((child) => (
            <BrowseableRow
              key={child.id}
              node={child}
              level={level + 1}
              tree={tree}
              activePointer={activePointer}
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

function ToolbarButton({ action, compact }: { action: ToolbarAction; compact?: boolean }) {
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
      onClick={handleClick}
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
