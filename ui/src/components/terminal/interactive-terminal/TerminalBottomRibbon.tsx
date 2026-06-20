import React from 'react';
import type { AgenticProcess } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { BookMarked, FileText } from 'lucide-react';
import { PromptLibraryMenu } from '@src/components/prompt-library/PromptLibraryMenu';
import { useIsAdvanced } from '@src/components/view-mode';
import { SideTabTooltipContent } from './LastPromptTooltip';
import { SIDE_TABS, SideTabId, type SideTabId as SideTabIdType } from './side-windows';

interface TerminalBottomRibbonProps {
  fileCount: number;
  isActive: boolean;
  promptCount?: number;
  /** Most recent prompt text — shown in the Prompts icon hover card. */
  lastPromptText?: string | null;
  openTabs: SideTabIdType[];
  activeSideTab: SideTabIdType | null;
  onOpenSideTab: (tab: SideTabIdType) => void;
  hasLastPlan?: boolean;
  onOpenLastPlan?: () => void;
  /** Enables the Prompt Library button (prompt → queue needs a process). */
  process?: AgenticProcess | null;
}

const RIBBON_TABS: SideTabIdType[] = [
  SideTabId.Context,
  SideTabId.Git,
  SideTabId.Prompts,
  SideTabId.Files,
  SideTabId.Dir,
  // The prompt QUEUE side-tab (previously URL-only) — paired with the
  // Prompt Library button below so "add to queue" has a visible destination.
  SideTabId.Queue,
];

export const TerminalBottomRibbon: React.FC<TerminalBottomRibbonProps> = ({
  fileCount,
  isActive,
  promptCount = 0,
  lastPromptText = null,
  openTabs,
  activeSideTab,
  onOpenSideTab,
  hasLastPlan = false,
  onOpenLastPlan,
  process = null,
}) => {
  const isAdvanced = useIsAdvanced();
  // Skin layer: in Standard view, power-user tabs (flagged advancedOnly on
  // their SIDE_TABS descriptor) and the Prompt Library button are hidden,
  // leaving Prompts + Files. See docs/viewmodes.md.
  const ribbonTabs = isAdvanced ? RIBBON_TABS : RIBBON_TABS.filter((id) => !SIDE_TABS[id].advancedOnly);
  return (
    <div className="flex items-center border-t bg-muted/30 px-4 py-1.5">
      {/* Left: process status LED */}
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-2 w-2 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-red-500'}`}
        />
        {hasLastPlan && onOpenLastPlan && (
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onOpenLastPlan}
                  className="h-6 gap-1.5 px-2 text-[11px] text-blue-400 border-blue-400/40 hover:border-blue-400 hover:text-blue-300"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Open Plan
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                Open the latest plan
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {/* Right: side tab toggle buttons */}
      <div className="ml-auto flex items-center gap-1">
        <TooltipProvider delayDuration={400}>
          {ribbonTabs.map((tabId) => {
            const descriptor = SIDE_TABS[tabId];
            const Icon = descriptor.icon;
            const isOpen = openTabs.includes(tabId);
            const isActive = isOpen && activeSideTab === tabId;
            const isPrompts = tabId === SideTabId.Prompts;

            // Badge for files and prompts
            let badge: number | null = null;
            if (tabId === SideTabId.Files) badge = fileCount;
            if (isPrompts) badge = promptCount;

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
                <SideTabTooltipContent
                  side="top"
                  isPrompts={isPrompts}
                  lastPromptText={lastPromptText}
                  promptCount={promptCount}
                  fallback={descriptor.description}
                />
              </Tooltip>
            );
          })}
          {/* Prompt Library — distinct from the transcript "Prompts" tab:
              browse the foldered prompt library; click a prompt to enqueue
              it (docs/prompt-library.md). Pure composition; all behavior
              lives in PromptLibraryMenu / the generic groups layer. */}
          {process && isAdvanced && (
            <PromptLibraryMenu
              process={process}
              projectId={process.project_id ?? null}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label="Prompt Library"
                  title="Prompt Library — click a prompt to add it to the queue"
                >
                  <BookMarked className="h-4 w-4" />
                </Button>
              }
            />
          )}
        </TooltipProvider>
      </div>
    </div>
  );
};
