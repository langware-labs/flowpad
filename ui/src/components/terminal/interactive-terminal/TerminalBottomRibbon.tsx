import React from 'react';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { QueueButton } from './QueueButton';
import type { QueueEntry, QueueState } from '@src/hooks/useAgenticQueue';
import { SIDE_TABS, SideTabId, type SideTabId as SideTabIdType } from './side-windows';

interface TerminalBottomRibbonProps {
  fileCount: number;
  isActive: boolean;
  promptCount?: number;
  queue?: QueueState;
  onQueueAdd?: (entry: QueueEntry) => void;
  onQueueRemove?: (index: number) => void;
  openTabs: SideTabIdType[];
  activeSideTab: SideTabIdType | null;
  onOpenSideTab: (tab: SideTabIdType) => void;
}

const QueueNextLabel: React.FC<{ queue: QueueState }> = ({ queue }) => {
  const next = (queue.entries ?? [])[0];
  const text = next?.queue_entry_data.prompt ?? '';
  const isEmpty = !text;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="max-w-[160px] cursor-default truncate text-[11px] text-muted-foreground/70 select-none">
          {isEmpty ? 'No pending prompts' : text}
        </span>
      </TooltipTrigger>
      {!isEmpty && (
        <TooltipContent side="top" className="max-w-xs whitespace-pre-wrap break-words">
          {text}
        </TooltipContent>
      )}
    </Tooltip>
  );
};

const RIBBON_TABS: SideTabIdType[] = [
  SideTabId.Shell,
  SideTabId.Git,
  SideTabId.Prompts,
  SideTabId.Queue,
  SideTabId.Files,
];

export const TerminalBottomRibbon: React.FC<TerminalBottomRibbonProps> = ({
  fileCount,
  isActive,
  promptCount = 0,
  queue,
  onQueueAdd,
  onQueueRemove,
  openTabs,
  activeSideTab,
  onOpenSideTab,
}) => {
  return (
    <div className="flex items-center border-t bg-muted/30 px-4 py-1.5">
      {/* Left: process status LED + queue */}
      <div className="flex items-center gap-2">
        <div className="relative flex h-2.5 w-2.5 items-center justify-center">
          {isActive && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              isActive ? 'bg-emerald-500' : 'bg-muted-foreground/30'
            }`}
          />
        </div>
        <span className="text-[11px] text-muted-foreground">
          {isActive ? 'running' : 'idle'}
        </span>
        {queue && onQueueAdd && onQueueRemove && (
          <TooltipProvider delayDuration={400}>
            <QueueButton
              queue={queue}
              onAdd={onQueueAdd}
              onRemove={onQueueRemove}
              onOpenPanel={() => onOpenSideTab(SideTabId.Queue)}
            />
            <QueueNextLabel queue={queue} />
          </TooltipProvider>
        )}
      </div>

      {/* Right: side tab toggle buttons */}
      <div className="ml-auto flex items-center gap-1">
        <TooltipProvider delayDuration={400}>
          {RIBBON_TABS.map((tabId) => {
            const descriptor = SIDE_TABS[tabId];
            const Icon = descriptor.icon;
            const isOpen = openTabs.includes(tabId);
            const isActive = isOpen && activeSideTab === tabId;

            // Badge for files and prompts
            let badge: number | null = null;
            if (tabId === SideTabId.Files) badge = fileCount;
            if (tabId === SideTabId.Prompts) badge = promptCount;

            return (
              <Tooltip key={tabId}>
                <TooltipTrigger asChild>
                  <div className="relative">
                    <Button
                      variant={isActive ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => onOpenSideTab(tabId)}
                      className={cn(
                        'h-7 w-7 p-0',
                        isActive && 'text-foreground',
                        isOpen && !isActive && 'text-muted-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </Button>
                    {/* Open-but-not-active indicator: thin bottom border */}
                    {isOpen && !isActive && (
                      <span className="pointer-events-none absolute bottom-0 left-1 right-1 h-px rounded-full bg-primary/50" />
                    )}
                    {badge != null && badge > 0 && (
                      <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] text-primary-foreground">
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {descriptor.description}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
      </div>
    </div>
  );
};
