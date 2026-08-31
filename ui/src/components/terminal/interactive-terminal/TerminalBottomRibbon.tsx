import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Artifact, type AgenticProcess } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { BookMarked, ChevronDown, FileText } from 'lucide-react';
import { PromptLibraryMenu } from '@src/components/prompt-library/PromptLibraryMenu';
import { useIsAdvanced } from '@src/components/view-mode';
import { compareArtifactsNewest } from '@src/hooks/use-process-artifacts';
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
  /** Deliverables this run REGISTERED (`flow artifact …`), in any order. */
  artifacts?: Artifact[];
  /** Open an artifact's REFERENCED ASSET by path — never the artifact row. */
  onOpenArtifact?: (assetRef: string) => void;
  /** Enables the Prompt Library button (prompt → queue needs a process). */
  process?: AgenticProcess | null;
  /** Chat composer rendered as the top tier of the ribbon (Standard/chat only). */
  composer?: React.ReactNode;
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
  artifacts = [],
  onOpenArtifact,
  process = null,
  composer,
}) => {
  const { t } = useLingui();
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
        {/* Left: worker status LED. The chat⇄terminal toggle that used to live
          here is now the mode selector in the footer (ViewToggle). */}
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-2 w-2 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-red-500'}`} />
          {hasLastPlan && onOpenLastPlan && (
            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onOpenLastPlan}
                    className="h-6 gap-1.5 border-blue-400/40 px-2 text-[11px] text-blue-400 hover:border-blue-400 hover:text-blue-300"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <Trans>Open Plan</Trans>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  <Trans>Open the latest plan</Trans>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {artifacts.length > 0 && onOpenArtifact && <ArtifactsChip artifacts={artifacts} onOpen={onOpenArtifact} />}
        </div>

        {/* Right: side tab toggle buttons */}
        <div className="ms-auto flex items-center gap-1" data-testid="terminal-ribbon-tabs">
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
                    fallback={t(descriptor.description)}
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
                    aria-label={t`Prompt Library`}
                    title={t`Prompt Library — click a prompt to add it to the queue`}
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
 * "Open Artifact" chip — mirrors the Open-Plan chip, and replaces the
 * markdown-docs chip it is modelled on: an authored `.md` was only ever a proxy
 * for "the run produced something", while an Artifact is the run SAYING so.
 *
 * Shows the newest registration; when there is more than one, a subtle chevron
 * opens a popover listing all of them newest-first.
 *
 * Clicking opens the artifact's REFERENCED ASSET, never the artifact row. An
 * artifact points at a deliverable — it is not the deliverable — so an artifact
 * with no `asset_ref` (a webapp registered by port, say) has nothing to open
 * and the click is inert rather than routing somewhere wrong.
 */
const ARTIFACT_CHIP_CLASSES = 'h-6 text-violet-400 border-violet-400/40 hover:border-violet-400 hover:text-violet-300';

const ArtifactsChip: React.FC<{
  artifacts: Artifact[];
  onOpen: (assetRef: string) => void;
}> = ({ artifacts, onOpen }) => {
  const { t } = useLingui();
  const ArtifactIcon = iconForType(Artifact.type);
  const ordered = [...artifacts].sort(compareArtifactsNewest);
  const latest = ordered[0];
  const hasMore = ordered.length > 1;
  const open = (artifact: Artifact) => {
    if (artifact.asset_ref) onOpen(artifact.asset_ref);
  };
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => open(latest)}
              className={cn(ARTIFACT_CHIP_CLASSES, 'gap-1.5 px-2 text-[11px]', hasMore && 'rounded-e-none border-e-0')}
            >
              <ArtifactIcon className="h-3.5 w-3.5" />
              <span className="max-w-[10rem] truncate">{latest.name}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <Trans>Open the latest artifact</Trans>
          </TooltipContent>
        </Tooltip>
        {hasMore && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label={t`Choose an artifact to open`}
                className={cn(ARTIFACT_CHIP_CLASSES, 'rounded-s-none px-1')}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-64 p-1">
              <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                {ordered.map((artifact) => (
                  <button
                    key={String(artifact.id)}
                    type="button"
                    onClick={() => open(artifact)}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-start hover:bg-accent"
                  >
                    <ArtifactIcon className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">{artifact.name}</span>
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
