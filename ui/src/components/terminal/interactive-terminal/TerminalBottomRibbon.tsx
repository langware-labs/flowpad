import React from 'react';
import type { AgenticProcess, MarkdownDoc } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { BookMarked, ChevronDown, FileText, Loader2, MessageSquare, SquareTerminal } from 'lucide-react';
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
  /** User-facing markdown docs this process authored, oldest-first (tail = latest). */
  markdownDocs?: MarkdownDoc[];
  /** Open a doc by path (docs viewer). */
  onOpenMarkdown?: (path: string) => void;
  /** Enables the Prompt Library button (prompt → queue needs a process). */
  process?: AgenticProcess | null;
  /** Chat composer rendered as the top tier of the ribbon (Standard/chat only). */
  composer?: React.ReactNode;
  /** True when the chat UI is currently shown (vs the xterm terminal). */
  chatActive?: boolean;
  /** Flip chat⇄terminal (saved override). When omitted, the status dot is shown instead. */
  onToggleView?: () => void;
  /** True while a chat⇄terminal switch is in flight — disables the toggle and
   *  shows a connect spinner (PTY spawn/teardown is no longer instant). */
  switching?: boolean;
}

const RIBBON_TABS: SideTabIdType[] = [
  SideTabId.Context,
  SideTabId.Git,
  SideTabId.Prompts,
  SideTabId.Analysis,
  SideTabId.SkillsAgents,
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
  markdownDocs = [],
  onOpenMarkdown,
  process = null,
  composer,
  chatActive = false,
  onToggleView,
  switching = false,
}) => {
  const isAdvanced = useIsAdvanced();
  // Skin layer: in Standard view, power-user tabs (flagged advancedOnly on
  // their SIDE_TABS descriptor) and the Prompt Library button are hidden,
  // leaving Prompts + Files. See docs/viewmodes.md.
  const ribbonTabs = isAdvanced ? RIBBON_TABS : RIBBON_TABS.filter((id) => !SIDE_TABS[id].advancedOnly);
  return (
    <div className="flex flex-col border-t bg-muted/30">
      {/* Top tier: chat composer (Standard/chat only) — one ribbon, not two rows. */}
      {composer && <div className="px-4 pb-1 pt-2">{composer}</div>}
      {/* Controls strip: status LED + plan/doc chips + side-tab launchers. */}
      <div className="flex items-center px-4 py-1.5">
      {/* Left: chat⇄terminal toggle (falls back to a status LED when no toggle). */}
      <div className="flex items-center gap-2">
        {onToggleView ? (
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onToggleView}
                  disabled={switching}
                  aria-label={chatActive ? 'Switch to terminal view' : 'Switch to chat view'}
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                >
                  {switching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : chatActive ? (
                    <SquareTerminal className="h-4 w-4" />
                  ) : (
                    <MessageSquare className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {switching
                  ? 'Switching…'
                  : chatActive
                    ? 'Switch to terminal view'
                    : 'Switch to chat view'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <span className={`inline-flex h-2 w-2 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-red-500'}`} />
        )}
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
        {markdownDocs.length > 0 && onOpenMarkdown && (
          <MarkdownDocsChip docs={markdownDocs} onOpen={onOpenMarkdown} />
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
    </div>
  );
};

/**
 * "Open Doc" chip — mirrors the Open-Plan chip. Shows the latest authored
 * markdown doc (the list tail); when there is more than one, a subtle chevron
 * opens a popover listing all docs newest-first so any can be opened.
 */
const DOC_CHIP_CLASSES =
  'h-6 text-emerald-400 border-emerald-400/40 hover:border-emerald-400 hover:text-emerald-300';

const MarkdownDocsChip: React.FC<{
  docs: MarkdownDoc[];
  onOpen: (path: string) => void;
}> = ({ docs, onOpen }) => {
  const latest = docs[docs.length - 1];
  const hasMore = docs.length > 1;
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpen(latest.path)}
              className={cn(
                DOC_CHIP_CLASSES,
                'gap-1.5 px-2 text-[11px]',
                hasMore && 'rounded-r-none border-r-0',
              )}
            >
              <FileText className="h-3.5 w-3.5" />
              <span className="max-w-[10rem] truncate">{latest.name}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Open the latest doc
          </TooltipContent>
        </Tooltip>
        {hasMore && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="Choose a doc to open"
                className={cn(DOC_CHIP_CLASSES, 'rounded-l-none px-1')}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-64 p-1">
              <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                {[...docs].reverse().map((doc) => (
                  <button
                    key={doc.path}
                    type="button"
                    onClick={() => onOpen(doc.path)}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-accent"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">{doc.name}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {doc.change === 'create' ? 'new' : 'edit'}
                    </span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </TooltipProvider>
  );
};
