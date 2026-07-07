import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { InlineRenameInput } from '@src/components/favorites/InlineRenameInput';
import { useInlineRename } from '@src/components/favorites/use-inline-rename';
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
  onNavigate,
  isLoading,
  emptyState,
  size = 'default',
  leadingChrome,
  onDropToBackground,
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
          size={size}
        />
      ))}
    </div>
  );
}

function GridTile({
  node,
  bus,
  navigate,
  activePointer,
  size,
}: {
  node: Browseable;
  bus: DragBus;
  navigate: (pointer: DockPointer) => void;
  activePointer: DockPointer | null;
  size: 'default' | 'large';
}) {
  const isContainer = !!node.listChildren;
  const rename = useInlineRename(node.label, (next) => node.onRename?.(next));
  const { editing, startEditing } = rename;

  const [dragOver, setDragOver] = useState(false);
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

  const isSelected = !!(
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
    else void node.activate?.();
  };

  const handleDragStart = (e: React.DragEvent) => {
    if (!node.dragData) return;
    e.stopPropagation();
    writeBrowseableDrag(e, node.dragData);
    e.dataTransfer.setDragImage(e.currentTarget as Element, 32, 32);
    bus.setDragData(node.dragData);
  };

  const handleDragEnd = () => {
    setDragOver(false);
    bus.setDragData(null);
  };

  const canAcceptDrop =
    !!node.onDrop && !!bus.dragData && (!node.canDrop || node.canDrop(bus.dragData));
  const canAcceptForeign = (e: React.DragEvent) =>
    !!node.onDrop && !bus.dragData && hasBrowseableDrag(e);

  const handleDragOver = (e: React.DragEvent) => {
    if (!canAcceptDrop && !canAcceptForeign(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      const payload = bus.dragData ?? readBrowseableDrag(e);
      setDragOver(false);
      if (!payload || !node.onDrop) return;
      if (node.canDrop && !node.canDrop(payload)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropping(true);
      try {
        await node.onDrop(payload);
      } finally {
        setDropping(false);
        bus.setDragData(null);
      }
    },
    [bus, node],
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
        dragOver && 'border-primary bg-primary/10 ring-1 ring-primary/40',
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
