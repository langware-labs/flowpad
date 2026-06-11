/**
 * TabStrip — the generic, kind-agnostic strip extracted from TabbedTerminal
 * (docs/tab-management.md Part 3 §6). Owns the presentation-level behaviors
 * every tab kind shares:
 *
 *   - chip row with horizontal scroll, overflow chevrons, scroll-into-view on
 *     active change (ResizeObserver re-evaluates on layout shifts)
 *   - double-click / context-menu rename editing (the OWNER validates+saves;
 *     the strip only manages the input UI and emits the trimmed name)
 *   - per-chip popout + close buttons, close-all / close-others / close-right
 *     context-menu actions, the close-all badge button
 *   - pending-glow rendering and per-chip tooltips
 *
 * It is URL-first by construction: a chip click only emits `onSelect(key)` —
 * the consumer navigates; active state arrives back via the `activeKey` prop
 * (derived from the URL). The strip never writes any global state.
 */
import { Button } from '@src/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

/** One chip in the strip. Kind-agnostic: terminals, entity tabs, and the
 *  transient preview tab all render through this shape. */
export interface TabStripItem {
  /** Canonical tab key (TypeId string for entity tabs, pointer key for transient). */
  key: string;
  /** Display title. */
  title: string;
  /** Leading icon node (resolved by the owner — vendor override ?? type icon). */
  icon?: React.ReactNode;
  /** Extra inline markers after the icon (e.g. worktree badge). */
  badge?: React.ReactNode;
  isDisabled?: boolean;
  statusReason?: string;
  /** Soft attention glow (never on the active chip). */
  isPending?: boolean;
  /** Rename capability — present iff the tab has a target entity (Part 3 §3). */
  renameable?: boolean;
  /** Hover tooltip content; falls back to statusReason when disabled. */
  tooltip?: React.ReactNode;
  /** data-testid for the chip. */
  testId?: string;
  /** Value for the data-provider attribute on the icon wrapper (test hook). */
  dataAttributes?: Record<string, string>;
  /** Extra per-chip context-menu entries (e.g. the transient preview tab's
   *  "Keep as tab" promotion — tab-management.md Part 3 §5). */
  contextMenuItems?: TabStripContextMenuItem[];
}

export interface TabStripContextMenuItem {
  label: string;
  shortcut?: string;
  onSelect: () => void;
}

export interface TabStripProps {
  items: TabStripItem[];
  activeKey: string;
  /** Chip click — consumer navigates (URL-first); never called for disabled chips. */
  onSelect: (key: string) => void;
  /** Close one tab (chip X / context menu / mod+W). Owner dispatches per-kind close. */
  onClose: (key: string) => void;
  /** Close many (close-all button / close-others / close-right). One batch. */
  onCloseMany?: (keys: string[]) => void;
  /** Rename commit with the trimmed new name. Only offered on renameable items. */
  onRename?: (key: string, name: string) => void;
  /** Pop the tab out (Part 3 §7/§8). */
  onPopout?: (key: string) => void;
  /** Extra "new tab" context-menu entries (owner-specific openers). */
  newTabMenuItems?: TabStripContextMenuItem[];
  /** Shortcut label for the Close entry (e.g. "Ctrl+W"). */
  closeShortcutLabel?: string;
  /** Leading fixed node (e.g. ProjectsCounterChip). */
  leading?: React.ReactNode;
  /** Trailing node that sticks to the right edge inside the scroll row. */
  trailing?: React.ReactNode;
  /** Hide the aggregated close-all badge button. */
  hideCloseAllButton?: boolean;
  /** Global-section items (entity tabs with projectId == null) rendered AFTER
   *  a visual divider with a "Global" checkbox (Part 3 §6). Pass `undefined`
   *  to omit the section entirely (the default for embedded strips). */
  globalItems?: TabStripItem[];
  /** Whether the global section is expanded (state lifted to the owner,
   *  persisted in localStorage by the owner). */
  showGlobalSection?: boolean;
  onToggleShowGlobalSection?: (show: boolean) => void;
  testId?: string;
}

export const TabStrip: React.FC<TabStripProps> = ({
  items,
  activeKey,
  onSelect,
  onClose,
  onCloseMany,
  onRename,
  onPopout,
  newTabMenuItems,
  closeShortcutLabel,
  leading,
  trailing,
  hideCloseAllButton,
  globalItems,
  showGlobalSection,
  onToggleShowGlobalSection,
  testId = 'terminal-tab-bar',
}) => {
  // Visible chip universe: main items + (expanded) global-section items.
  // Scroll-into-view, the close-all badge and "Close All" operate over it;
  // close-others / close-right stay scoped to the section a chip lives in.
  const visibleGlobalItems = globalItems !== undefined && showGlobalSection ? globalItems : [];
  const allVisibleItems = visibleGlobalItems.length > 0 ? items.concat(visibleGlobalItems) : items;
  const tabContainerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [hasTabOverflow, setHasTabOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const shouldSelectRenameInputRef = useRef(false);

  const scrollSelectedTabIntoView = useCallback((targetKey: string, behavior: ScrollBehavior = 'smooth') => {
    const container = tabContainerRef.current;
    const tab = tabRefs.current[targetKey];
    if (!container || !tab) return;

    const tabLeft = tab.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;
    const visibleLeft = container.scrollLeft;
    const visibleRight = visibleLeft + container.clientWidth;

    if (tabLeft < visibleLeft) {
      container.scrollTo({ left: tabLeft, behavior });
      return;
    }

    if (tabRight > visibleRight) {
      container.scrollTo({ left: tabRight - container.clientWidth, behavior });
    }
  }, []);

  // Auto scroll-into-view: on initial mount the active chip may be in view
  // only because the strip is still short; when the rest of the items land,
  // the chip gets pushed off-screen. ResizeObserver re-evaluates on either
  // layout shift — the scroll is a no-op once the chip is genuinely visible.
  const hasActiveItem = allVisibleItems.some((i) => i.key === activeKey);
  const lastScrolledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeKey || !hasActiveItem) return;
    const isFirstScrollForKey = lastScrolledKeyRef.current !== activeKey;
    lastScrolledKeyRef.current = activeKey;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollSelectedTabIntoView(activeKey, isFirstScrollForKey ? 'auto' : 'smooth');
      });
    });
  }, [activeKey, hasActiveItem, scrollSelectedTabIntoView, allVisibleItems.length]);

  useEffect(() => {
    const container = tabContainerRef.current;
    if (!container || !activeKey || !hasActiveItem) return;
    const observer = new ResizeObserver(() => {
      scrollSelectedTabIntoView(activeKey, 'auto');
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeKey, hasActiveItem, scrollSelectedTabIntoView]);

  const updateScrollState = useCallback(() => {
    const container = tabContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const hasOverflow = scrollWidth > clientWidth + 1;
    setHasTabOverflow(hasOverflow);
    // 1px epsilon matches the right-side check: sub-pixel scrollLeft values
    // (macOS trackpad inertia, fractional zoom) would otherwise keep the
    // left chevron lit when visually at the start.
    setCanScrollLeft(hasOverflow && scrollLeft > 1);
    setCanScrollRight(hasOverflow && scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  const scrollTabs = (direction: 'left' | 'right') => {
    const container = tabContainerRef.current;
    if (!container) return;

    const scrollAmount = 200; // pixels to scroll
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  useEffect(() => {
    updateScrollState();
    const container = tabContainerRef.current;
    if (!container) return;

    const handleScroll = () => updateScrollState();
    container.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', updateScrollState);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [items, visibleGlobalItems.length, updateScrollState]);

  // Rename editing — the strip owns the input UI; the owner owns validation
  // and the save (entity rename / PTY `/rename` are kind strategies).
  const startRename = (key: string, currentName: string) => {
    shouldSelectRenameInputRef.current = true;
    setEditingKey(key);
    setEditingName(currentName);
  };

  useEffect(() => {
    if (!editingKey || !shouldSelectRenameInputRef.current) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, input.value.length);
  });

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    shouldSelectRenameInputRef.current = false;
    setEditingName(e.target.value);
  };

  const handleNameBlur = () => {
    shouldSelectRenameInputRef.current = false;
    if (editingKey && editingName.trim()) {
      onRename?.(editingKey, editingName.trim());
    }
    setEditingKey(null);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleNameBlur();
    } else if (e.key === 'Escape') {
      shouldSelectRenameInputRef.current = false;
      setEditingKey(null);
    } else {
      shouldSelectRenameInputRef.current = false;
    }
  };

  const closeMany = (keys: string[]) => {
    if (keys.length === 0) return;
    if (onCloseMany) onCloseMany(keys);
    else keys.forEach((k) => onClose(k));
  };

  // One chip — shared by the main row and the global section. `list` scopes
  // the close-others / close-right context-menu actions to the chip's section.
  const renderChip = (item: TabStripItem, index: number, list: TabStripItem[]) => {
    const { key } = item;
    const isActive = activeKey === key;
    const isDisabled = !!item.isDisabled;
    const isPending = !!item.isPending && !isActive;

    const tabContent = (
      <div
        ref={(node) => {
          tabRefs.current[key] = node;
        }}
        className={`group flex shrink-0 select-none items-center gap-2 rounded-t border-b-2 px-3 py-1.5 transition-colors ${
          isDisabled
            ? 'cursor-not-allowed border-transparent bg-muted/30 text-muted-foreground/50'
            : isActive
              ? 'cursor-pointer border-primary bg-background text-foreground'
              : 'cursor-pointer border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
        } ${isPending ? 'animate-pending-glow rounded-md' : ''}`}
        onClick={() => {
          if (isDisabled) return;
          onSelect(key);
        }}
        data-testid={item.testId}
        data-terminal-target={key}
        {...(item.dataAttributes ?? {})}
      >
        {item.icon}
        {item.badge}
        {editingKey === key ? (
          <input
            ref={renameInputRef}
            type="text"
            value={editingName}
            onChange={handleNameChange}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            className="min-w-[80px] rounded border border-border bg-background px-1 py-0 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
            onFocus={(e) => {
              if (shouldSelectRenameInputRef.current) {
                e.currentTarget.setSelectionRange(0, e.currentTarget.value.length);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="text-sm font-medium"
            onDoubleClick={(e) => {
              if (!item.renameable) return;
              e.stopPropagation();
              startRename(key, item.title);
            }}
          >
            {item.title}
          </span>
        )}

        {onPopout && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPopout(key);
            }}
            disabled={isDisabled}
            className="rounded p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 group-hover:opacity-100"
            aria-label="Open in external browser"
            title="Open in external browser"
            data-testid={`tab-open-external-${item.dataAttributes?.['data-indicator-key'] ?? key}`}
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose(key);
          }}
          disabled={isDisabled}
          className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 group-hover:opacity-100"
          aria-label="Close tab"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );

    return (
      <ContextMenu key={key}>
        <TooltipProvider delayDuration={600}>
          <Tooltip>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild>{tabContent}</ContextMenuTrigger>
            </TooltipTrigger>
            {item.tooltip ? (
              <TooltipContent side="bottom" className="border bg-popover p-2.5 text-popover-foreground shadow-md">
                {item.tooltip}
              </TooltipContent>
            ) : isDisabled && item.statusReason ? (
              <TooltipContent side="bottom">{item.statusReason}</TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
        <ContextMenuContent>
          {item.renameable && (
            <>
              <ContextMenuItem onSelect={() => startRename(key, item.title)}>Rename</ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {item.contextMenuItems && item.contextMenuItems.length > 0 && (
            <>
              {item.contextMenuItems.map((entry) => (
                <ContextMenuItem key={entry.label} onSelect={entry.onSelect}>
                  {entry.label}
                  {entry.shortcut && (
                    <span className="ml-auto pl-4 text-xs text-muted-foreground">{entry.shortcut}</span>
                  )}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
            </>
          )}
          {newTabMenuItems && newTabMenuItems.length > 0 && (
            <>
              {newTabMenuItems.map((entry) => (
                <ContextMenuItem key={entry.label} onSelect={entry.onSelect}>
                  {entry.label}
                  {entry.shortcut && (
                    <span className="ml-auto pl-4 text-xs text-muted-foreground">{entry.shortcut}</span>
                  )}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => onClose(key)}>
            Close{' '}
            {closeShortcutLabel && (
              <span className="ml-auto pl-4 text-xs text-muted-foreground">{closeShortcutLabel}</span>
            )}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => closeMany(allVisibleItems.map((i) => i.key))}>Close All</ContextMenuItem>
          <ContextMenuItem
            onSelect={() => closeMany(list.filter((i) => i.key !== key).map((i) => i.key))}
            disabled={list.length <= 1}
          >
            Close All But This
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => closeMany(list.slice(index + 1).map((i) => i.key))}
            disabled={index >= list.length - 1}
          >
            Close to the Right
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    // min-w-0/max-w-full: the strip must never size its host to content —
    // hosts are flex children and would otherwise blow out to the sum of all
    // chip widths (the off-screen right-arrow/close-all/toolbar bug).
    <div className="flex min-w-0 max-w-full items-center border-b bg-muted" data-testid={testId}>
      {leading}
      {/* Left Scroll Button — always reserves layout space when tabs
          overflow, so toggling `canScrollLeft` doesn't shift the
          tab row horizontally. Mirrors the right-button pattern. */}
      {hasTabOverflow && (
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 shrink-0 rounded-none ${canScrollLeft ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          onClick={() => scrollTabs('left')}
          aria-label="Scroll tabs left"
          tabIndex={canScrollLeft ? 0 : -1}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      )}

      {/* Scrollable Tab Container */}
      <div
        ref={tabContainerRef}
        data-testid="terminal-tabs-scroll-container"
        className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 pl-2 pr-0"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {items.map((item, index) => renderChip(item, index, items))}

        {/* Global section (Part 3 §6): divider + "Global" checkbox, then the
            projectless entity tabs when expanded. Only rendered when the
            owner opts in via `globalItems`. */}
        {globalItems !== undefined && (
          <div
            className="ml-1 flex shrink-0 items-center gap-1.5 self-stretch border-l border-border pl-2 pr-1"
            data-testid="tab-strip-global-divider"
          >
            <label className="flex cursor-pointer select-none items-center gap-1 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="h-3 w-3 accent-primary"
                checked={!!showGlobalSection}
                onChange={(e) => onToggleShowGlobalSection?.(e.target.checked)}
                data-testid="tab-strip-global-toggle"
              />
              Global
            </label>
          </div>
        )}
        {visibleGlobalItems.map((item, index) => renderChip(item, index, visibleGlobalItems))}

        {/* Trailing toolbar flows after the last tab but sticks to the right
            edge when tabs overflow. Placement is unconditional, so it does
            not oscillate with hasTabOverflow. */}
        {trailing && <div className="sticky right-0 z-10 flex items-center self-stretch bg-muted">{trailing}</div>}
      </div>

      {/* Right Scroll Button */}
      {hasTabOverflow && (
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 shrink-0 rounded-none ${canScrollRight ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          onClick={() => scrollTabs('right')}
          aria-label="Scroll tabs right"
          data-testid="scroll-tabs-right-button"
          tabIndex={canScrollRight ? 0 : -1}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      )}

      {/* Close All button — shown when 2+ tabs are open. Tab count badge
          hints at the destructive scope before clicking. */}
      {!hideCloseAllButton && allVisibleItems.length >= 2 && (
        <TooltipProvider delayDuration={600}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="mx-1.5 h-6 shrink-0 gap-1.5 rounded-md border-border bg-background px-2 text-foreground shadow-sm hover:border-destructive/60 hover:bg-destructive/10 hover:text-destructive"
                onClick={() => closeMany(allVisibleItems.map((i) => i.key))}
                aria-label={`Close all ${allVisibleItems.length} tabs`}
                data-testid="close-all-tabs-button"
              >
                <X className="h-3.5 w-3.5" />
                <span className="inline-flex h-4 min-w-[1.125rem] items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-semibold tabular-nums leading-none text-foreground">
                  {allVisibleItems.length}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close all {allVisibleItems.length} tabs</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
};

export default TabStrip;
