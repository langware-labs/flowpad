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
 *   - The shell is right-anchored (`border-l`) and vertical. A bottom variant
 *     would be a sibling primitive, not a prop on this one.
 *   - Width is per-caller (Tailwind token). Default `w-80`.
 *   - Title + count badge are optional; omit the whole header implicitly by
 *     leaving all three (title, count, onOpenChange) unset.
 */
export interface SideDrawerProps {
  open: boolean;
  /** Omit to render as always-on (X close button hidden). */
  onOpenChange?: (open: boolean) => void;
  title?: string;
  /** Right-aligned header badge — e.g. run count. */
  count?: number;
  /** Tailwind width token. Default `w-80`. */
  width?: string;
  className?: string;
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
  children,
  'data-testid': dataTestId,
}: SideDrawerProps) {
  if (!open) return null;

  const hasHeader = !!title || count !== undefined || !!onOpenChange;

  return (
    <div
      className={cn('flex shrink-0 flex-col border-l bg-background', width, className)}
      data-testid={dataTestId}
    >
      {hasHeader && (
        <div className="flex h-[52px] flex-shrink-0 items-center gap-1 border-b px-3">
          {title && <span className="text-xs font-medium text-muted-foreground">{title}</span>}
          {count !== undefined && (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {count}
            </span>
          )}
          {onOpenChange && (
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6"
              onClick={() => onOpenChange(false)}
              aria-label={title ? `Close ${title.toLowerCase()}` : 'Close'}
              data-testid={dataTestId ? `${dataTestId}-close` : undefined}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
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
  /** Optional hover tooltip under the tab. */
  description?: string;
}

/**
 * ``SideDrawer`` + a top tab strip. Only the active tab's children are mounted.
 *
 * ``data-testid`` on each tab trigger follows ``${dataTestId}-tab-${id}`` if
 * ``data-testid`` is provided on the drawer (e.g. ``md-side-window-tab-chat``),
 * letting browser tests find tabs by their stable id rather than label.
 */
export interface TabbedSideDrawerProps<TabId extends string = string>
  extends Omit<SideDrawerProps, 'children' | 'title' | 'count'> {
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
  'data-testid': dataTestId,
}: TabbedSideDrawerProps<TabId>) {
  if (!open) return null;

  const triggerPrefix = tabTestIdPrefix ?? (dataTestId ? `${dataTestId}-tab` : undefined);

  return (
    <div
      className={cn('flex shrink-0 flex-col border-l bg-background', width, className)}
      data-testid={dataTestId}
    >
      {/* Tab strip — uses the drawer header row. Close button (if provided) is right-aligned. */}
      <div className="flex items-center gap-0.5 border-b px-2 py-1">
        <TooltipProvider delayDuration={400}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.id === activeTab;
            return (
              <Tooltip key={tab.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onActiveTabChange(tab.id)}
                    data-testid={triggerPrefix ? `${triggerPrefix}-${tab.id}` : undefined}
                    data-active={isActive ? 'true' : 'false'}
                    className={cn(
                      'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5',
                      isActive
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    <span className="text-[11px]">{tab.label}</span>
                  </button>
                </TooltipTrigger>
                {tab.description && (
                  <TooltipContent side="bottom" className="text-xs">
                    {tab.description}
                  </TooltipContent>
                )}
              </Tooltip>
            );
          })}
        </TooltipProvider>
        {onOpenChange && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6"
            onClick={() => onOpenChange(false)}
            aria-label={closeLabel}
            title={closeLabel}
            data-testid={dataTestId ? `${dataTestId}-close` : undefined}
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {/* Only the active panel is mounted — keeps state isolated per tab. */}
      <div className="min-h-0 flex-1 overflow-hidden">{children[activeTab]}</div>
    </div>
  );
}
