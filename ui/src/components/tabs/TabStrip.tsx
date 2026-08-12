/**
 * TabStrip — the generic, kind-agnostic strip extracted from TabbedTerminal
 * (docs/tab-management.md Part 3 §6). Owns the presentation-level behaviors
 * every tab kind shares:
 *
 *   - Chrome-style equal-width chips: every tab is always visible; chips share
 *     the row width (flex basis 200px, min 40px) and shrink in lockstep as tabs
 *     are added — the strip never scrolls
 *   - density degradation: as the shared chip width falls, the popout button,
 *     then the close button (overlay-on-hover), then the title drop out
 *   - double-click / context-menu rename editing (the OWNER validates+saves;
 *     the strip only manages the input UI and emits the trimmed name)
 *   - per-chip popout + close buttons, close-all / close-others / close-right
 *     context-menu actions, the close-all badge button
 *   - per-chip tooltips (the primary way to read a heavily-truncated title)
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
import { ExternalLink, X, type LucideIcon } from 'lucide-react';
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
  /** Whether the chip can be closed (default true). A `closable: false` chip
   *  hides its X, is excluded from close-all/close-others/close-right, and shows
   *  no "Close" context item — for pinned fixtures like the vibe "Display" chip. */
  closable?: boolean;
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
  /** Renders the entry as a distinguished header row at the TOP of the menu
   *  (accented, above Rename, own separator) instead of a plain item — for
   *  navigation shortcuts like "Open Project" that aren't tab operations. */
  emphasized?: boolean;
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
  /** Trailing fixed node (opener toolbar) — sits after the tab row, never
   *  overlaps or shrinks; the chips share whatever width remains. */
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

/** Strip-wide chip density, derived from the SHARED chip width (all chips are
 *  equal-width by construction, so one number describes every chip):
 *  `normal` = icon + title + in-flow hover buttons; `compact` = no popout,
 *  close is an overlay; `icon` = icon only, close overlay on hover/active. */
type ChipDensity = 'normal' | 'compact' | 'icon';

/** Preferred/max chip width — the SAME constant drives the flex layout (inline
 *  style) and the density thresholds, so the two can't drift apart. */
const CHIP_MAX_PX = 200;
/** Icon-only floor — chips never shrink below this; past it the row clips. */
const CHIP_MIN_PX = 40;
const COMPACT_BELOW_PX = 110;
const ICON_ONLY_BELOW_PX = 64;

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
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const shouldSelectRenameInputRef = useRef(false);

  // Density: one ResizeObserver on the row; all chips share one width
  // (row / count, clamped to the chip max), so a single strip-level state
  // keeps every chip's composition identical — no per-chip measurement.
  const [density, setDensity] = useState<ChipDensity>('normal');
  useEffect(() => {
    const container = tabContainerRef.current;
    if (!container) return;
    const compute = () => {
      // Unmeasurable container (0 width — e.g. jsdom, display:none host):
      // stay at 'normal' rather than degrading on a bogus measurement.
      const width = container.clientWidth;
      if (!width) return;
      const per = Math.min(width / (items.length || 1), CHIP_MAX_PX);
      setDensity(per >= COMPACT_BELOW_PX ? 'normal' : per >= ICON_ONLY_BELOW_PX ? 'compact' : 'icon');
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(container);
    return () => observer.disconnect();
  }, [items.length]);

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

  // Pinned (closable === false) chips are never batch-closed.
  const closableKeys = new Set(items.filter((i) => i.closable === false).map((i) => i.key));
  const closeMany = (keys: string[]) => {
    const closeable = keys.filter((k) => !closableKeys.has(k));
    if (closeable.length === 0) return;
    if (onCloseMany) onCloseMany(closeable);
    else closeable.forEach((k) => onClose(k));
  };

  // One context-menu group: the entries followed by a separator. Shared by the
  // per-chip extra entries (item.contextMenuItems) and the owner's "new tab"
  // entries (newTabMenuItems) — identical rendering, different source.
  const renderMenuGroup = (entries: TabStripContextMenuItem[] | undefined) => {
    if (!entries || entries.length === 0) return null;
    return (
      <>
        {entries.map((entry) => (
          <ContextMenuItem
            key={entry.label}
            onSelect={entry.onSelect}
            className={entry.emphasized ? 'bg-accent/50 font-medium text-foreground focus:bg-accent' : undefined}
          >
            {entry.Icon && <entry.Icon className={`me-2 h-4 w-4${entry.emphasized ? 'text-primary' : ''}`} />}
            {entry.label}
            {entry.shortcut && <span className="ms-auto ps-4 text-xs text-muted-foreground">{entry.shortcut}</span>}
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

  const activeIndex = allVisibleItems.findIndex((i) => i.key === activeKey);

  // Popout + close live in an absolute overlay at EVERY density (the Chrome
  // model): in-flow buttons would reserve ~48px of every chip even while
  // invisible and crush the title. The overlay is backed by the chip surface
  // color so it reads over truncated text; close is always visible on the
  // active chip, hover-revealed on inactive ones; popout is hover-only and
  // drops out below normal density.
  const renderButtonOverlay = (key: string, isActive: boolean, isDisabled: boolean, closable = true) => (
    <div
      className={`absolute right-0.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded transition-opacity ${
        isActive ? 'bg-background opacity-100' : 'bg-muted opacity-0 group-hover:opacity-100'
      }`}
    >
      {density === 'normal' && onPopout && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPopout(key);
          }}
          disabled={isDisabled}
          className={`rounded p-0.5 hover:bg-muted-foreground/20 ${isActive ? 'opacity-0 group-hover:opacity-100' : ''}`}
          aria-label={t`Open in external browser`}
          title={t`Open in external browser`}
          data-testid={`tab-open-external-${key}`}
        >
          <ExternalLink className="h-3 w-3" />
        </button>
      )}
      {closable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose(key);
          }}
          disabled={isDisabled}
          className="rounded p-0.5 hover:bg-destructive/20"
          aria-label={t`Close tab`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  // One chip in the single ordered row. `list` scopes close-others / close-right.
  const renderChip = (item: TabStripItem, index: number, list: TabStripItem[]) => {
    const { key } = item;
    const isActive = activeKey === key;
    const isDisabled = !!item.isDisabled;
    const hasError = !!item.hasError;
    const isEditing = editingKey === key;
    const iconOnly = density === 'icon' && !isEditing;

    // Chrome model: equal flex share for every chip — all tabs stay visible and
    // shrink in lockstep; the strip never scrolls. Inline style (not Tailwind
    // literals) so the widths come from the same constants the density math
    // uses. An editing chip is temporarily pinned to the full preferred width
    // so the rename input is usable; neighbors re-equalize around it.
    const sizing: React.CSSProperties = isEditing
      ? { width: CHIP_MAX_PX, flex: 'none' }
      : { flex: `1 1 ${CHIP_MAX_PX}px`, minWidth: CHIP_MIN_PX, maxWidth: CHIP_MAX_PX };

    const tabContent = (
      <div
        ref={(node) => {
          tabRefs.current[key] = node;
        }}
        style={sizing}
        // `border-t-2` on EVERY state, colored only when active: the accent has
        // to follow the `rounded-t-lg` curve, and a border does that natively.
        // It used to be an absolutely-positioned 2px bar, which `overflow-hidden`
        // clipped into a straight chord across the corner curve — the ends came
        // out visibly pointed. Uniform on all states so activation never changes
        // a chip's metrics.
        className={`group relative flex select-none items-center overflow-hidden rounded-t-lg border border-t-2 py-1.5 transition-colors ${
          iconOnly ? 'justify-center gap-0 px-1' : 'gap-2 px-3'
        } ${
          isDisabled
            ? 'cursor-not-allowed border-transparent bg-transparent text-muted-foreground/50'
            : hasError
              ? 'cursor-pointer border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'
              : isActive
                ? // Active tab shares the body background and opens its bottom edge
                  // (-mb-px over the baseline) so it reads as one surface with the
                  // content below — a folder-tab continuum lifted off the muted band.
                  // Its top border IS the accent, so it hugs the rounded corners.
                  'z-10 -mb-px cursor-pointer border-border border-b-transparent border-t-primary bg-background text-foreground shadow-sm'
                : // Inactive tabs are flat on the band (Chrome-style); the
                  // transparent border keeps their box metrics identical to the
                  // active chip so activation never shifts neighbors.
                  'cursor-pointer border-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
        } ${dragKey === key ? 'opacity-60' : ''}`}
        onPointerDown={(e) => startDrag(e, key, isDisabled)}
        onClick={() => {
          if (isDisabled) return;
          if (justDraggedRef.current) return; // a drag just ended — don't navigate
          onSelect(key);
        }}
        data-testid={item.testId}
        data-terminal-target={key}
        data-active={isActive ? 'true' : undefined}
        {...(item.dataAttributes ?? {})}
      >
        {item.icon}
        {!iconOnly && item.badge}
        {isEditing ? (
          <input
            ref={renameInputRef}
            type="text"
            value={editingName}
            onChange={handleNameChange}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            className="w-full min-w-0 rounded border border-border bg-background px-1 py-0 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
            onFocus={(e) => {
              if (shouldSelectRenameInputRef.current) {
                e.currentTarget.setSelectionRange(0, e.currentTarget.value.length);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          !iconOnly && (
            <span
              // The active chip's close button is persistent (overlay) — keep
              // the title clear of it; inactive titles reclaim the full width.
              className={`min-w-0 flex-1 truncate text-sm font-medium ${isActive ? 'pr-4' : ''} ${item.titleClassName ?? ''}`}
              onDoubleClick={(e) => {
                if (!item.renameable) return;
                e.stopPropagation();
                startRename(key, item.title);
              }}
            >
              {item.title}
            </span>
          )
        )}

        {!isEditing && renderButtonOverlay(key, isActive, isDisabled, item.closable !== false)}
      </div>
    );

    // Separator between chips (Chrome-style): hidden next to the active chip so
    // the raised tab reads as a single surface. Kept as a transparent element
    // (not removed) so chip geometry is stable; shown everywhere during a drag
    // to avoid flicker while the active index moves under the preview.
    const hideSeparator = !dragKey && (index - 1 === activeIndex || index === activeIndex);
    const separator =
      index > 0 ? (
        <div
          aria-hidden
          className={`h-4 w-px shrink-0 self-center ${hideSeparator ? 'bg-transparent' : 'bg-border/60'}`}
        />
      ) : null;

    return (
      <React.Fragment key={key}>
        {separator}
        <ContextMenu>
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
            {/* Emphasized shortcuts (e.g. "Open Project") sit above the tab
                operations as an accented header group — they navigate, they
                don't mutate the tab, so they must not read as one more entry. */}
            {renderMenuGroup(item.contextMenuItems?.filter((e) => e.emphasized))}
            {item.renameable && (
              <>
                <ContextMenuItem onSelect={() => startRename(key, item.title)}>
                  <Trans>Rename</Trans>
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            {renderMenuGroup(item.contextMenuItems?.filter((e) => !e.emphasized))}
            {renderMenuGroup(newTabMenuItems)}
            {item.closable !== false && (
              <ContextMenuItem onSelect={() => onClose(key)}>
                <Trans>Close</Trans>{' '}
                {closeShortcutLabel && (
                  <span className="ms-auto ps-4 text-xs text-muted-foreground">{closeShortcutLabel}</span>
                )}
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => closeMany(allVisibleItems.map((i) => i.key))}>
              <Trans>Close All</Trans>
            </ContextMenuItem>
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
      </React.Fragment>
    );
  };

  return (
    // The strip is a muted BAND (theme tokens only — muted contrasts with
    // background in every theme) that the active chip lifts out of into the
    // body. min-w-0/max-w-full: the strip must never size its host to content.
    <div className="flex min-w-0 max-w-full items-end bg-muted" data-testid={testId}>
      {leading}

      {/* Tab row — chips share this width equally and are ALL always visible
          (Chrome model). overflow-hidden only matters past the 40px/chip floor
          (~25+ tabs at 1000px), where the row clips instead of scrolling. */}
      <div
        ref={tabContainerRef}
        data-testid="terminal-tabs-row"
        className="flex min-w-0 flex-1 items-end overflow-hidden pe-1 ps-2 pt-1"
      >
        {items.map((item, index) => renderChip(item, index, items))}
      </div>

      {/* Trailing toolbar — a fixed sibling AFTER the row (never overlaps or
          shrinks); the chips absorb all width pressure. */}
      {trailing && <div className="flex shrink-0 items-center self-stretch">{trailing}</div>}

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
            <TooltipContent side="bottom">
              <Trans>Close all {allVisibleItems.length} tabs</Trans>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
};

export default TabStrip;
