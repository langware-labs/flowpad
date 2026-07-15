import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { InlineRenameInput } from './InlineRenameInput';
import { useInlineRename } from './use-inline-rename';
import { cn } from '@src/lib/utils';
import type { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import { hasBrowseableDrag, readBrowseableDrag, writeBrowseableDrag } from './drag';
import { ToolbarButton } from './BrowseableTree';
import type { Browseable, BrowseableDragData } from './types';

export interface BrowseableGridProps {
  /** Top-level nodes. Folder-like nodes (listChildren) expand into a popover
   *  grid of their children; leaves activate via `pointer ?? activate`. */
  roots: Browseable[];
  activePointer?: DockPointer | null;
  /** Highlight a specific node by its `selectionKey` (id-based), independent of
   *  `activePointer`. Reusable across all node types — including non-navigable
   *  ones (no pointer) — e.g. to pre-select a just-created favorite by its id. */
  selectedKey?: string;
  /** Defaults to `navigation.openDock` (URL-first). */
  onNavigate?: (pointer: DockPointer) => void;
  isLoading?: boolean;
  emptyState?: ReactNode;
  /** 'default' = compact home strip; 'large' = Launchpad dialog sizing. */
  size?: 'default' | 'large';
  /** Chrome tiles rendered before the nodes (e.g. the "+" quick-create tile). */
  leadingChrome?: ReactNode;
  /** Drop on the surface background (not on a tile) — e.g. un-file to root. */
  onDropToBackground?: (drag: BrowseableDragData) => void;
  /** Manual ordering of THIS grid's tiles: a drop on a tile's left/right edge
   *  splices the dragged item before/after it. Containers own their children's
   *  ordering via `node.reorderChildren` (used by the folder popover grids). */
  onReorder?: (
    drag: BrowseableDragData,
    anchor: { afterId?: string; beforeId?: string },
  ) => void | Promise<void>;
  className?: string;
}

interface DragBus {
  dragData: BrowseableDragData | null;
  setDragData: (d: BrowseableDragData | null) => void;
}

/**
 * BrowseableGrid — the desktop/launchpad renderer for the Browseable
 * container protocol (BrowseableTree's sibling). Same nodes, same invariants:
 * click resolves as `pointer ?? activate`; folder expansion is the grid's
 * popover (the tree's chevron); toolbar actions are side effects (first one
 * doubles as the tile's hover corner button); DnD speaks the shared
 * cross-surface MIME contract from ./drag.ts.
 */
export function BrowseableGrid({
  roots,
  activePointer = null,
  selectedKey,
  onNavigate,
  isLoading,
  emptyState,
  size = 'default',
  leadingChrome,
  onDropToBackground,
  onReorder,
  className,
}: BrowseableGridProps) {
  const { navigation } = useDockNavigation();
  const navigate = onNavigate ?? ((p: DockPointer) => navigation.openDock(p));
  // Intra-grid drag fast path (full payload during dragover); foreign drags
  // fall back to the MIME contract, same rules as BrowseableTree.
  const [dragData, setDragData] = useState<BrowseableDragData | null>(null);
  const bus: DragBus = { dragData, setDragData };

  const handleBackgroundDragOver = (e: React.DragEvent) => {
    if (!onDropToBackground) return;
    if (!dragData && !hasBrowseableDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleBackgroundDrop = (e: React.DragEvent) => {
    if (!onDropToBackground) return;
    const payload = dragData ?? readBrowseableDrag(e);
    setDragData(null);
    if (!payload) return;
    e.preventDefault();
    onDropToBackground(payload);
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-3',
        size === 'large' && 'gap-4',
        className,
      )}
      onDragOver={handleBackgroundDragOver}
      onDrop={handleBackgroundDrop}
      data-testid="browseable-grid"
    >
      {leadingChrome}
      {isLoading && roots.length === 0 && (
        <div className="flex h-16 w-16 items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
      {!isLoading && roots.length === 0 && emptyState}
      {roots.map((node) => (
        <GridTile
          key={node.id}
          node={node}
          bus={bus}
          navigate={navigate}
          activePointer={activePointer}
          selectedKey={selectedKey}
          size={size}
          onReorder={onReorder}
        />
      ))}
    </div>
  );
}

type DropZone = 'before' | 'after' | 'center';

function GridTile({
  node,
  bus,
  navigate,
  activePointer,
  selectedKey,
  size,
  onReorder,
}: {
  node: Browseable;
  bus: DragBus;
  navigate: (pointer: DockPointer) => void;
  activePointer: DockPointer | null;
  selectedKey?: string;
  size: 'default' | 'large';
  onReorder?: BrowseableGridProps['onReorder'];
}) {
  const isContainer = !!node.listChildren;
  const rename = useInlineRename(node.label, (next) => node.onRename?.(next));
  const { editing, startEditing } = rename;

  const [dragOver, setDragOver] = useState<DropZone | null>(null);
  const [dropping, setDropping] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [children, setChildren] = useState<Browseable[] | null>(null);

  // Children derive from the adapter's live closures — reload whenever the
  // node object is rebuilt (adapters memoize on their data, so identity
  // change == data change) or the popover opens.
  useEffect(() => {
    if (!isContainer || !popoverOpen) return;
    let cancelled = false;
    void node.listChildren?.().then((next) => {
      if (!cancelled) setChildren(next);
    });
    return () => {
      cancelled = true;
    };
  }, [node, isContainer, popoverOpen]);

  const isSelected =
    // id-based selection (works for non-navigable nodes too)
    (!!selectedKey && node.selectionKey === selectedKey) ||
    // pointer-based (URL-derived) selection
    !!(
      node.pointer &&
      activePointer &&
      node.pointer.viewType === activePointer.viewType &&
      node.pointer.pointer === activePointer.pointer
    );

  const actionable = !!(node.pointer || node.activate || isContainer);

  const handleClick = (e: React.MouseEvent) => {
    if (editing) {
      e.preventDefault();
      return;
    }
    if (isContainer) return; // PopoverTrigger's composed handler toggles.
    if (node.pointer) navigate(node.pointer);
    else if (node.activate) void node.activate();
    else return; // Non-actionable row (e.g. a missing favorite) — nothing opened.
    // After dispatch, so a throwing usage stamp can never break navigation.
    node.onOpen?.();
  };

  const handleDragStart = (e: React.DragEvent) => {
    if (!node.dragData) return;
    e.stopPropagation();
    writeBrowseableDrag(e, node.dragData);
    e.dataTransfer.setDragImage(e.currentTarget as Element, 32, 32);
    bus.setDragData(node.dragData);
  };

  const handleDragEnd = () => {
    setDragOver(null);
    bus.setDragData(null);
  };

  const canAcceptDrop =
    !!node.onDrop && !!bus.dragData && (!node.canDrop || node.canDrop(bus.dragData));
  const canAcceptForeign = (e: React.DragEvent) =>
    !!node.onDrop && !bus.dragData && hasBrowseableDrag(e);
  const canReorder = (e: React.DragEvent) =>
    !!onReorder && (!!bus.dragData || hasBrowseableDrag(e));

  // Hit zones: tile edges (left/right quarter — or halves on plain leaves)
  // splice the dragged item before/after this tile; the center is the
  // container drop (file into folder). Self-drags never register.
  const zoneFor = (e: React.DragEvent): DropZone | null => {
    const isSelf = !!bus.dragData && bus.dragData.id === node.id;
    if (isSelf) return null;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / Math.max(rect.width, 1);
    const containerDrop = canAcceptDrop || canAcceptForeign(e);
    const reorderDrop = canReorder(e);
    if (containerDrop && reorderDrop) {
      if (x < 0.25) return 'before';
      if (x > 0.75) return 'after';
      return 'center';
    }
    if (containerDrop) return 'center';
    if (reorderDrop) return x < 0.5 ? 'before' : 'after';
    return null;
  };

  const handleDragOver = (e: React.DragEvent) => {
    const zone = zoneFor(e);
    if (!zone) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(zone);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(null);
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      const zone = zoneFor(e);
      const payload = bus.dragData ?? readBrowseableDrag(e);
      setDragOver(null);
      if (!payload || !zone) return;
      e.preventDefault();
      e.stopPropagation();
      setDropping(true);
      try {
        if (zone === 'center') {
          if (!node.onDrop || (node.canDrop && !node.canDrop(payload))) return;
          await node.onDrop(payload);
        } else if (onReorder) {
          await onReorder(
            payload,
            zone === 'before' ? { beforeId: node.id } : { afterId: node.id },
          );
        }
      } finally {
        setDropping(false);
        bus.setDragData(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bus, node, onReorder],
  );

  const tileButton = (
    <button
      type="button"
      onClick={handleClick}
      onDoubleClick={(e) => {
        if (!node.onRename) return;
        e.preventDefault();
        startEditing();
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2' && node.onRename) {
          e.preventDefault();
          startEditing();
        }
      }}
      draggable={!!node.dragData && !editing}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
      aria-label={node.label}
      data-browseable-id={node.id}
      className={cn(
        'flex flex-col items-center justify-center gap-1 rounded-md border border-border bg-background text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        size === 'large' ? 'h-20 w-20' : 'h-16 w-16',
        actionable
          ? 'cursor-pointer hover:border-primary hover:bg-accent hover:text-foreground'
          : 'cursor-not-allowed',
        isSelected && 'border-primary text-foreground',
        dragOver === 'center' && 'border-primary bg-primary/10 ring-1 ring-primary/40',
        dragOver === 'before' && 'shadow-[inset_3px_0_0_0_hsl(var(--primary))]',
        dragOver === 'after' && 'shadow-[inset_-3px_0_0_0_hsl(var(--primary))]',
        dropping && 'opacity-60',
        node.rowClassName,
      )}
    >
      <span className="relative">
        {node.icon}
        {node.badge && <span className="absolute -right-2 -top-1.5">{node.badge}</span>}
      </span>
      {editing ? (
        <InlineRenameInput rename={rename} />
      ) : (
        <span
          className={cn(
            'truncate text-[10px] font-medium leading-none',
            size === 'large' ? 'max-w-[72px]' : 'max-w-[56px]',
          )}
        >
          {node.label}
        </span>
      )}
    </button>
  );

  const contextItems = (
    <ContextMenuContent>
      {node.onRename && (
        <ContextMenuItem onSelect={() => setTimeout(startEditing, 0)}>
          <Trans>Rename</Trans>
        </ContextMenuItem>
      )}
      {node.onRename && node.toolbar && node.toolbar.length > 0 && <ContextMenuSeparator />}
      {node.toolbar?.map((action) => (
        <ContextMenuItem key={action.id} onSelect={() => void action.run()}>
          {action.label}
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  );

  // First toolbar action doubles as the tile's hover corner button (the
  // desktop grammar for the tree's inline hover toolbar).
  const cornerAction = node.toolbar?.[0];

  const wrapped = isContainer ? (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <ContextMenu>
        <PopoverTrigger asChild>
          <ContextMenuTrigger asChild>{tileButton}</ContextMenuTrigger>
        </PopoverTrigger>
        {contextItems}
      </ContextMenu>
      <PopoverContent
        align="start"
        className="w-auto max-w-[19rem] p-3"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => void handleDrop(e)}
      >
        {!children || children.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            <Trans>Drop items here</Trans>
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {children.map((child) => (
              <GridTile
                key={child.id}
                node={child}
                bus={bus}
                navigate={navigate}
                activePointer={activePointer}
                size="default"
                onReorder={
                  node.reorderChildren
                    ? (drag, anchor) => node.reorderChildren!(drag.id, anchor)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  ) : (
    <ContextMenu>
      {node.tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>{tileButton}</ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {node.tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        <ContextMenuTrigger asChild>{tileButton}</ContextMenuTrigger>
      )}
      {contextItems}
    </ContextMenu>
  );

  return (
    <div className="group relative">
      {wrapped}
      {cornerAction && (
        <div className="absolute -right-1 -top-1 hidden group-hover:flex">
          <ToolbarButton action={cornerAction} compact />
        </div>
      )}
    </div>
  );
}
