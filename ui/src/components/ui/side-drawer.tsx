import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { X, type LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode, SVGProps } from 'react';

/**
 * Shared right-side drawer shell. Consumed by surfaces that slide a panel in
 * from the right of a content area (e.g. markdown side window, workflow runs
 * list). Controlled: the caller owns the open state.
 *
 * Design rules:
 *   - When `onOpenChange` is provided, an X close button renders in the header.
 *     Omit `onOpenChange` to render as an always-on drawer (no X).
 *   - The shell is right-anchored (`border-s`) and vertical. A bottom variant
 *     would be a sibling primitive, not a prop on this one.
 *   - Width is per-caller (Tailwind token). Default `w-80`.
 *   - Title + count badge are optional; omit the whole header implicitly by
 *     leaving all three (title, count, onOpenChange) unset.
 */
export interface SideDrawerProps {
  open: boolean;
  /** Omit to render as always-on (X close button hidden). */
  onOpenChange?: (open: boolean) => void;
  /** Header title. A node (not just a string) so callers can prefix an icon. */
  title?: ReactNode;
  /** Right-aligned header badge — e.g. run count. */
  count?: number;
  /** Tailwind width token. Default `w-80`. */
  width?: string;
  className?: string;
  /**
   * Caller-owned controls rendered right-aligned in the header, before the
   * close X (e.g. a Refresh button, a Run button + asset picker). Lets a panel
   * keep its header actions without hand-rolling the drawer chrome. Only shows
   * when a header is present (title, count, onOpenChange, or headerActions).
   */
  headerActions?: ReactNode;
  children: ReactNode;
  'data-testid'?: string;
}

export function SideDrawer({
  open,
  onOpenChange,
  title,
  count,
  width = 'w-80',
  className,
  headerActions,
  children,
  'data-testid': dataTestId,
}: SideDrawerProps) {
  if (!open) return null;

  const hasHeader = !!title || count !== undefined || !!onOpenChange || !!headerActions;

  return (
    <div className={cn('flex shrink-0 flex-col border-s bg-background', width, className)} data-testid={dataTestId}>
      {hasHeader && (
        <div className="flex h-[52px] flex-shrink-0 items-center gap-1 border-b px-3">
          {title && <span className="text-xs font-medium text-muted-foreground">{title}</span>}
          {count !== undefined && (
            <span className="ms-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{count}</span>
          )}
          {headerActions && <div className="ms-auto flex items-center gap-1">{headerActions}</div>}
          {onOpenChange && (
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-6 w-6', !headerActions && 'ms-auto')}
              onClick={() => onOpenChange(false)}
              aria-label={typeof title === 'string' ? `Close ${title.toLowerCase()}` : 'Close'}
              data-testid={dataTestId ? `${dataTestId}-close` : undefined}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * Tab descriptor consumed by ``TabbedSideDrawer``. Callers define their own
 * descriptor maps near the tab bodies; the primitive just renders whatever
 * it's handed.
 */
export interface TabDescriptor<TabId extends string = string> {
  id: TabId;
  label: string;
  icon: LucideIcon;
  /** Optional hover tooltip under the tab (simple string). */
  description?: string;
  /**
   * Rich hover tooltip node — overrides `description` when present. The host
   * builds the whole `<TooltipContent>` (so any domain logic stays host-side);
   * the primitive only decides whether a tooltip renders.
   */
  tooltip?: ReactNode;
  /** Render a per-tab close X (workspace model). Requires `onCloseTab`. */
  closable?: boolean;
}

/**
 * ``SideDrawer`` + a top tab strip. Only the active tab's children are mounted.
 *
 * ``data-testid`` on each tab trigger follows ``${dataTestId}-tab-${id}`` if
 * ``data-testid`` is provided on the drawer (e.g. ``md-side-window-tab-chat``),
 * letting browser tests find tabs by their stable id rather than label.
 */
export interface TabbedSideDrawerProps<TabId extends string = string> extends Omit<
  SideDrawerProps,
  'children' | 'title' | 'count'
> {
  tabs: TabDescriptor<TabId>[];
  activeTab: TabId;
  onActiveTabChange: (tab: TabId) => void;
  /** Map of tabId → panel. Only the active one is rendered. */
  children: Partial<Record<TabId, ReactNode>>;
  /** Override the default tab-trigger testid prefix (see docstring). */
  tabTestIdPrefix?: string;
  /** Icon for the close button. Defaults to `X` (dismiss). Pass e.g.
   *  `PanelRightClose` for a "fold to the right" drawer affordance. */
  closeIcon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Tooltip / aria-label for the close button. Defaults to "Close". */
  closeLabel?: string;
  /** Per-tab close handler. A close X renders on a tab only when this is set
   *  AND the tab's descriptor has `closable`. Used by the workspace model
   *  (terminal side windows) where tabs are individually openable/closable. */
  onCloseTab?: (tab: TabId) => void;
  /** Truncate tab labels longer than two words to "first two…". The full
   *  label is preserved in `title`/`aria-label` (and the close-button label). */
  truncateLabels?: boolean;
  /** Allow the tab strip to scroll horizontally when it overflows. */
  scrollableTabs?: boolean;
}

export function TabbedSideDrawer<TabId extends string>({
  open,
  onOpenChange,
  width = 'w-80',
  className,
  tabs,
  activeTab,
  onActiveTabChange,
  children,
  tabTestIdPrefix,
  closeIcon: CloseIcon = X,
  closeLabel = 'Close',
  onCloseTab,
  truncateLabels = false,
  scrollableTabs = false,
  'data-testid': dataTestId,
}: TabbedSideDrawerProps<TabId>) {
  if (!open) return null;

  const triggerPrefix = tabTestIdPrefix ?? (dataTestId ? `${dataTestId}-tab` : undefined);

  return (
    <div className={cn('flex shrink-0 flex-col border-s bg-background', width, className)} data-testid={dataTestId}>
      {/* Tab strip — the drawer header row. The tabs live in their own
          (optionally horizontally-scrolling) track; the close button is a
          shrink-0 sibling OUTSIDE that track so overflowing tabs can never push
          it off-screen or scroll it out of view. */}
      <div className="flex items-center gap-0.5 border-b px-2 py-1">
        <div className={cn('flex min-w-0 flex-1 items-center gap-0.5', scrollableTabs && 'overflow-x-auto')}>
          <TooltipProvider delayDuration={400}>
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.id === activeTab;
              const words = tab.label.split(' ');
              const display = truncateLabels && words.length > 2 ? words.slice(0, 2).join(' ') + '…' : tab.label;
              // Rich `tooltip` node wins; else fall back to the simple `description` string.
              const tip =
                tab.tooltip ??
                (tab.description && (
                  <TooltipContent side="bottom" className="text-xs">
                    {tab.description}
                  </TooltipContent>
                ));
              // Close X renders as a SIBLING of the trigger button (never nested —
              // invalid HTML) and only in the workspace model.
              const showClose = !!onCloseTab && !!tab.closable;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'flex shrink-0 items-center gap-0.5 rounded',
                    isActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onActiveTabChange(tab.id)}
                        data-testid={triggerPrefix ? `${triggerPrefix}-${tab.id}` : undefined}
                        data-active={isActive ? 'true' : 'false'}
                        title={display !== tab.label ? tab.label : undefined}
                        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5"
                      >
                        <Icon className="h-3 w-3" />
                        <span className="text-[11px]">{display}</span>
                      </button>
                    </TooltipTrigger>
                    {tip}
                  </Tooltip>
                  {showClose && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                      aria-label={`Close ${tab.label}`}
                      className="me-0.5 rounded hover:text-foreground"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </TooltipProvider>
        </div>
        {onOpenChange && (
          <Button
            variant="ghost"
            size="icon"
            className="ms-1 h-6 w-6 shrink-0"
            onClick={() => onOpenChange(false)}
            aria-label={closeLabel}
            title={closeLabel}
            data-testid={dataTestId ? `${dataTestId}-close` : undefined}
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {/* Only the active panel is mounted — keeps state isolated per tab.
          `flex flex-col` (not a bare block) is REQUIRED: panels make their own
          root `flex-1` and rely on this wrapper being a flex column to get a
          bounded height. As a plain block, `flex-1` is inert, the panel grows to
          its content height, and the surplus is clipped by `overflow-hidden`
          with no scrollbar (see dir_panel_scroll.md.ts). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children[activeTab]}</div>
    </div>
  );
}
