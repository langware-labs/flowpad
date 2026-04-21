import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import type { ReactNode } from 'react';
import { MD_SIDE_TABS, MD_SIDE_TABS_ORDER, type MdSideTabId } from './SideWindowTypes';

interface SideWindowProps {
  activeTab: MdSideTabId;
  onSelect: (id: MdSideTabId) => void;
  /** Map of tabId → panel; only the active one is mounted. */
  children: Partial<Record<MdSideTabId, ReactNode>>;
  className?: string;
}

/**
 * Forked from terminal's SideWindow — stripped of the close-X and open/toggle reducer.
 * Always renders the tab strip (no empty state) and shows exactly one panel at a time.
 */
export function SideWindow({ activeTab, onSelect, children, className }: SideWindowProps) {
  return (
    <div
      className={cn('flex w-80 shrink-0 flex-col border-l bg-background', className)}
      data-testid="md-side-window"
    >
      {/* Tab strip */}
      <div className="flex items-center gap-0.5 border-b px-2 py-1">
        <TooltipProvider delayDuration={400}>
          {MD_SIDE_TABS_ORDER.map((tabId) => {
            const descriptor = MD_SIDE_TABS[tabId];
            const Icon = descriptor.icon;
            const isActive = tabId === activeTab;
            return (
              <Tooltip key={tabId}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSelect(tabId)}
                    data-testid={`md-side-tab-${tabId}`}
                    data-active={isActive ? 'true' : 'false'}
                    className={cn(
                      'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5',
                      isActive
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    <span className="text-[11px]">{descriptor.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {descriptor.description}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
      </div>

      {/* Active panel — only the mounted one keeps its state. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {children[activeTab]}
      </div>
    </div>
  );
}
