import React, { type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { SIDE_TABS, type SideTabId } from './SideWindowTypes';

interface SideWindowProps {
  tabs: SideTabId[];
  activeTab: SideTabId;
  onSelect: (id: SideTabId) => void;
  onClose: (id: SideTabId) => void;
  children: ReactNode;
}

export const SideWindow: React.FC<SideWindowProps> = ({ tabs, activeTab, onSelect, onClose, children }) => {
  return (
    <div className="flex w-80 shrink-0 flex-col border-l bg-background">
      {/* Tab strip */}
      <div className="flex items-center gap-0.5 overflow-x-auto border-b px-2 py-1">
        <TooltipProvider delayDuration={400}>
          {tabs.map((tabId) => {
            const descriptor = SIDE_TABS[tabId];
            const Icon = descriptor.icon;
            const isActive = tabId === activeTab;
            const words = descriptor.label.split(' ');
            const displayLabel = words.length > 2 ? words.slice(0, 2).join(' ') + '…' : descriptor.label;
            const isTruncated = words.length > 2;
            return (
              <Tooltip key={tabId}>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      'flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5',
                      isActive
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => onSelect(tabId)}
                  >
                    <Icon className="h-3 w-3" />
                    <span className="text-[11px]">{displayLabel}</span>
                    <button
                      className="ml-0.5 rounded hover:text-foreground"
                      onClick={(e) => { e.stopPropagation(); onClose(tabId); }}
                      aria-label={`Close ${descriptor.label}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {isTruncated ? descriptor.label : descriptor.description}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
};
