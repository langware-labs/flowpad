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
 *   - per-chip tooltips
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
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { ChevronLeft, ChevronRight, ExternalLink, X, type LucideIcon } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';

/** One chip in the strip. Kind-agnostic: terminals, entity tabs, and the
 *  transient preview tab all render through this shape. */
export interface TabStripItem {
  /** Canonical tab key (TypeId string for entity tabs, pointer key for transient). */
  key: string;
  /** Display title. */
  title: string;
  /** Extra classes for the title text (e.g. blue for projectless/global tabs). */
  titleClassName?: string;
  /** Leading icon node (resolved by the owner — vendor override ?? type icon). */
  icon?: React.ReactNode;
  /** Extra inline markers after the icon (e.g. worktree badge). */
  badge?: React.ReactNode;
  isDisabled?: boolean;
  hasError?: boolean;
  statusReason?: string;
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
  /** Optional leading icon (e.g. graph glyph for "Open Context"). */
  Icon?: LucideIcon;
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
  /** Drag-reorder (opt-in). During a drag the strip emits the predicted drop-gap
   *  anchors (chip keys; null = strip edge) so the owner can paint the optimistic
   *  order; on drop it emits the commit; a cancel (no move / escape) restores. */
  onReorderPreview?: (reorderKey: string, afterKey: string | null, beforeKey: string | null) => void;
  onReorderCommit?: (reorderKey: string, afterKey: string | null, beforeKey: string | null) => void;
  onReorderCancel?: () => void;
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
  onReorderPreview,
  onReorderCommit,
  onReorderCancel,
  testId = 'terminal-tab-bar',
}) => {
  const { t } = useLingui();
  // One ordered list (backend-owned) — projectless tabs are inline, no section.
  const allVisibleItems = items;
  // The rich per-tab info card is an Advanced/Dev affordance; Standard mode keeps
  // the calm minimal hover (statusReason / title only).
  const isAdvanced = useIsAdvanced();
  const tabContainerRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
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

    // Measure against the container's viewport rect (not offsetLeft/scrollLeft):
    // the scroll container is not a positioned offset-parent, so offsetLeft is
    // not relative to it and the partial-visibility math drifts — a chip clipped
    // by a pixel then never triggers a scroll. Rect deltas are exact and
    // scrollBy applies them regardless of offset-parent.
    const containerRect = container.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    // Breathing room so a selected chip lands fully clear of the edge / overflow
    // chevron rather than flush against it.
    const PAD = 8;

    // The trailing toolbar is `sticky right-0` INSIDE the scroll container, so it
    // paints on top of whatever scrolls under it. If we used the bare container
    // right edge, a rightmost chip would land with its X/open controls tucked
    // beneath the sticky toolbar — visible text, hidden controls. Treat the
    // toolbar's left edge as the effective right boundary so the whole chip
    // header (controls included) clears it.
    const trailingRect = trailingRef.current?.getBoundingClientRect();
    const effectiveRight =
      trailingRect && trailingRect.width > 0 ? Math.min(containerRect.right, trailingRect.left) : containerRect.right;

    if (tabRect.left < containerRect.left + PAD) {
      container.scrollBy({ left: tabRect.left - containerRect.left - PAD, behavior });
    } else if (tabRect.right > effectiveRight - PAD) {
      container.scrollBy({ left: tabRect.right - effectiveRight + PAD, behavior });
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
  }, [items, updateScrollState]);

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

  // One context-menu group: the entries followed by a separator. Shared by the
  // per-chip extra entries (item.contextMenuItems) and the owner's "new tab"
  // entries (newTabMenuItems) — identical rendering, different source.
  const renderMenuGroup = (entries: TabStripContextMenuItem[] | undefined) => {
    if (!entries || entries.length === 0) return null;
    return (
      <>
        {entries.map((entry) => (
          <ContextMenuItem key={entry.label} onSelect={entry.onSelect}>
            {entry.Icon && <entry.Icon className="mr-2 h-4 w-4" />}
            {entry.label}
            {entry.shortcut && <span className="ml-auto pl-4 text-xs text-muted-foreground">{entry.shortcut}</span>}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
      </>
    );
  };

  // ── Native pointer-drag reorder (no dnd dependency) ─────────────────────────
  // The strip never reorders its own array: it emits the predicted drop-gap
  // anchors and the owner repaints from the backend-owned store (so the dragged
  // chip flows under the cursor). Commit on drop; a no-move release is just a
  // click (suppressed so it doesn't navigate after a drag).
  const [dragKey, setDragKey] = useState<string | null>(null);
  const movedRef = useRef(false);
  const justDraggedRef = useRef(false);

  const anchorsAt = useCallback(
    (clientX: number, draggedKey: string): { after: string | null; before: string | null } => {
      // Single pass over the (non-dragged) chips: the gap is between the last
      // chip left of the cursor (`after`) and the first one right of it (`before`).
      let after: string | null = null;
      let before: string | null = null;
      for (const it of items) {
        if (it.key === draggedKey) continue;
        const el = tabRefs.current[it.key];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (clientX >= r.left + r.width / 2) {
          after = it.key;
        } else {
          before = it.key;
          break;
        }
      }
      return { after, before };
    },
    [items],
  );

  const startDrag = useCallback(
    (e: React.PointerEvent, key: string, isDisabled: boolean) => {
      if (!onReorderPreview || isDisabled || editingKey) return;
      if ((e.target as HTMLElement).closest('button,input')) return;
      const startX = e.clientX;
      movedRef.current = false;
      const onMove = (ev: PointerEvent) => {
        if (!movedRef.current && Math.abs(ev.clientX - startX) < 5) return;
        if (!movedRef.current) {
          movedRef.current = true;
          setDragKey(key);
        }
        const { after, before } = anchorsAt(ev.clientX, key);
        onReorderPreview(key, after, before);
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (movedRef.current) {
          const { after, before } = anchorsAt(ev.clientX, key);
          onReorderCommit?.(key, after, before);
          justDraggedRef.current = true;
          setTimeout(() => (justDraggedRef.current = false), 0);
        }
        setDragKey(null);
        movedRef.current = false;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [onReorderPreview, onReorderCommit, anchorsAt, editingKey],
  );

  // One chip in the single ordered row. `list` scopes close-others / close-right.
  const renderChip = (item: TabStripItem, index: number, list: TabStripItem[]) => {
    const { key } = item;
    const isActive = activeKey === key;
    const isDisabled = !!item.isDisabled;
    const hasError = !!item.hasError;

    const tabContent = (
      <div
        ref={(node) => {
          tabRefs.current[key] = node;
        }}
        className={`group relative flex shrink-0 select-none items-center gap-2 overflow-hidden rounded-t-lg border px-3 py-1.5 transition-colors ${
          isDisabled
            ? 'cursor-not-allowed border-transparent bg-transparent text-muted-foreground/50'
            : hasError
              ? 'cursor-pointer border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'
              : isActive
                ? // Active tab shares the body background and opens its bottom edge
                  // (-mb-px over the baseline) so it reads as one surface with the
                  // content below — a folder-tab continuum.
                  'z-10 -mb-px cursor-pointer border-border border-b-transparent bg-background text-foreground'
                : // Inactive tabs are raised, fully-bordered chips in the lighter
                  // muted tone so they never blend into the (darker) body.
                  'cursor-pointer border-border bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground'
        } ${dragKey === key ? 'opacity-60' : ''}`}
        onPointerDown={(e) => startDrag(e, key, isDisabled)}
        onClick={() => {
          if (isDisabled) return;
          if (justDraggedRef.current) return; // a drag just ended — don't navigate
          onSelect(key);
        }}
        data-testid={item.testId}
        data-terminal-target={key}
        {...(item.dataAttributes ?? {})}
      >
        {/* Active accent — absolutely positioned so it never shifts tab height. */}
        {isActive && !hasError && (
          <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary" />
        )}
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
            className={`max-w-[160px] truncate text-sm font-medium ${item.titleClassName ?? ''}`}
            onDoubleClick={(e) => {
              if (!item.renameable) return;
              e.stopPropagation();
              startRename(key, item.title);
            }}
          >
            {item.title}
          </span>
        )}

        {/* Hover-only affordance (opacity-0 until group-hover), rendered in
            every view mode so the chip's width is mode-invariant. Gating it on
            isAdvanced made Advanced chips ~24px wider than Standard ones, which
            reflowed the strip and shifted the selected tab when toggling View. */}
        {onPopout && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPopout(key);
            }}
            disabled={isDisabled}
            className="rounded p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 group-hover:opacity-100"
            aria-label={t`Open in external browser`}
            title={t`Open in external browser`}
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
          aria-label={t`Close tab`}
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
            {isAdvanced && item.tooltip ? (
              <TooltipContent side="bottom" className="border bg-popover p-2.5 text-popover-foreground shadow-md">
                {item.tooltip}
              </TooltipContent>
            ) : isDisabled && item.statusReason ? (
              <TooltipContent side="bottom">{item.statusReason}</TooltipContent>
            ) : item.title ? (
              <TooltipContent side="bottom">{item.title}</TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
        <ContextMenuContent>
          {item.renameable && (
            <>
              <ContextMenuItem onSelect={() => startRename(key, item.title)}><Trans>Rename</Trans></ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {renderMenuGroup(item.contextMenuItems)}
          {renderMenuGroup(newTabMenuItems)}
          <ContextMenuItem onSelect={() => onClose(key)}>
            <Trans>Close</Trans>{' '}
            {closeShortcutLabel && (
              <span className="ml-auto pl-4 text-xs text-muted-foreground">{closeShortcutLabel}</span>
            )}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => closeMany(allVisibleItems.map((i) => i.key))}><Trans>Close All</Trans></ContextMenuItem>
          <ContextMenuItem
            onSelect={() => closeMany(list.filter((i) => i.key !== key).map((i) => i.key))}
            disabled={list.length <= 1}
          >
            <Trans>Close All But This</Trans>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => closeMany(list.slice(index + 1).map((i) => i.key))}
            disabled={index >= list.length - 1}
          >
            <Trans>Close to the Right</Trans>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    // min-w-0/max-w-full: the strip must never size its host to content —
    // hosts are flex children and would otherwise blow out to the sum of all
    // chip widths (the off-screen right-arrow/close-all/toolbar bug).
    <div className="flex min-w-0 max-w-full items-end bg-background" data-testid={testId}>
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
          aria-label={t`Scroll tabs left`}
          tabIndex={canScrollLeft ? 0 : -1}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      )}

      {/* Scrollable Tab Container */}
      <div
        ref={tabContainerRef}
        data-testid="terminal-tabs-scroll-container"
        className="scrollbar-hide flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pb-0 pl-2 pr-0 pt-1"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {items.map((item, index) => renderChip(item, index, items))}

        {/* Trailing toolbar flows after the last tab but sticks to the right
            edge when tabs overflow. Placement is unconditional, so it does
            not oscillate with hasTabOverflow. */}
        {trailing && (
          <div ref={trailingRef} className="sticky right-0 z-10 flex items-center self-stretch bg-background">
            {trailing}
          </div>
        )}
      </div>

      {/* Right Scroll Button */}
      {hasTabOverflow && (
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 shrink-0 rounded-none ${canScrollRight ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          onClick={() => scrollTabs('right')}
          aria-label={t`Scroll tabs right`}
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
                aria-label={t`Close all ${allVisibleItems.length} tabs`}
                data-testid="close-all-tabs-button"
              >
                <X className="h-3.5 w-3.5" />
                <span className="inline-flex h-4 min-w-[1.125rem] items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-semibold tabular-nums leading-none text-foreground">
                  {allVisibleItems.length}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><Trans>Close all {allVisibleItems.length} tabs</Trans></TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
};

export default TabStrip;
