import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import type { Browseable, BrowseableTreeProps, ToolbarAction } from './types';
import { useBrowseableTree } from './useBrowseableTree';

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
  } = props;

  const tree = useBrowseableTree(roots);
  const lastResolvedRef = useRef<string | null>(null);

  const handleNavigate = useCallback(
    (pointer: DockPointer) => {
      onNavigate?.(pointer);
    },
    [onNavigate],
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
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    <div
      className={`flex h-full flex-col ${className}`}
      role="tree"
      aria-label={header?.title}
    >
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
}

function BrowseableRow({ node, level, tree, activePointer, onNavigate }: RowProps) {
  const expanded = tree.isExpanded(node.id);
  const loadState = tree.getLoadState(node.id);
  const children = tree.getChildren(node.id);

  const isSelected = !!(
    node.pointer &&
    activePointer &&
    node.pointer.viewType === activePointer.viewType &&
    node.pointer.pointer === activePointer.pointer
  );

  const hasChildrenHint =
    node.hasChildren === true || (node.hasChildren === 'unknown' && !!node.listChildren);

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

  return (
    <div data-browseable-id={node.id}>
      <div
        className={`group relative flex cursor-pointer items-center gap-1 rounded-md p-1.5 text-xs transition-colors ${
          isSelected ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-muted'
        }`}
        style={{ marginLeft: `${level * 14}px` }}
        role="treeitem"
        aria-level={level + 1}
        aria-selected={isSelected}
        aria-expanded={hasChildrenHint ? expanded : undefined}
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

          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
            onClick={handleRowClick}
          >
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
            <div
              className="p-1 text-xs text-muted-foreground"
              style={{ marginLeft: `${(level + 1) * 14}px` }}
            >
              Loading…
            </div>
          )}
          {loadState.status === 'error' && (
            <div
              className="p-1 text-xs text-destructive"
              style={{ marginLeft: `${(level + 1) * 14}px` }}
            >
              {loadState.message || 'Failed to load'}
            </div>
          )}
          {loadState.status === 'ready' && children.length === 0 && (
            <div
              className="p-1 text-xs text-muted-foreground"
              style={{ marginLeft: `${(level + 1) * 14}px` }}
            >
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
