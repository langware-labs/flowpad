import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import {
  canonicalPath,
  projectListToSelectorItems,
  ProjectSelector,
  type ProjectSelectorItem,
} from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { notify } from '@src/notifications';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { useTerminalProjectBuckets, type TerminalProjectBucket } from '@src/hooks/useActiveTerminals';
import { ChevronLeft, Layers, Loader2, RotateCcw } from 'lucide-react';
import React, { useMemo, useState } from 'react';

/** Agentic worker kinds offered by the picker's worker toolbar. */
export type ProjectWorkerType = 'claude_code' | 'codex';

interface ProjectsCounterChipProps {
  /** Project that the surrounding tab strip is currently scoped to. Used to highlight that row. */
  currentProjectId?: string | null;
  /**
   * When provided, the popover gains an "Open another project…" row below the
   * bucket list. Selecting a project in the embedded picker and clicking a
   * worker button calls this with the project's filesystem path and the
   * picked worker type; the host owns ensure + launch.
   */
  onLaunchProjectPath?: (cwd: string, workerType: ProjectWorkerType) => void | Promise<void>;
}

// Sort: current project first, then live before loading/missing, then by name.
const STATE_RANK: Record<TerminalProjectBucket['state'], number> = {
  live: 1,
  loading: 2,
  missing: 3,
};

function bucketDisplayName(bucket: TerminalProjectBucket): string {
  return bucket.project?.getDisplayName() ?? bucket.project?.name ?? bucket.projectId;
}

function compareBuckets(
  a: TerminalProjectBucket,
  b: TerminalProjectBucket,
  currentProjectId: string | null | undefined,
): number {
  const currentDiff = Number(b.projectId === currentProjectId) - Number(a.projectId === currentProjectId);
  if (currentDiff) return currentDiff;
  const stateDiff = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (stateDiff) return stateDiff;
  return bucketDisplayName(a).localeCompare(bucketDisplayName(b));
}

function bucketRowLabel(bucket: TerminalProjectBucket): string {
  if (bucket.state === 'live') return bucketDisplayName(bucket);
  if (bucket.state === 'loading') return 'Loading…';
  return `Project unavailable (${bucket.projectId.slice(0, 8)})`;
}

/**
 * Picker panel for the "Open another project…" row. Mounted only when the
 * user enters picker mode, so its data hooks (compute-node project scan)
 * never run for the plain counter chip. Projects that already have an open
 * bucket in the strip are excluded. Selecting a project arms the worker
 * toolbar below the list — each button opens that worker type on the
 * selected project, mirroring the tab strip's opener buttons.
 */
// Worker toolbar entries — mirrors the tab strip's opener buttons.
const PICKER_WORKERS: Array<{
  workerType: ProjectWorkerType;
  label: string;
  testId: string;
  Icon: React.FC<{ className?: string }>;
  iconClassName: string;
}> = [
  {
    workerType: 'claude_code',
    label: 'Open Claude Code on selected project',
    testId: 'projects-counter-picker-open-claude',
    Icon: ClaudeIcon,
    iconClassName: 'text-orange-500',
  },
  {
    workerType: 'codex',
    label: 'Open Codex on selected project',
    testId: 'projects-counter-picker-open-codex',
    Icon: CodexIcon,
    iconClassName: 'text-emerald-500',
  },
];

const ProjectPickerPanel: React.FC<{
  /** Canonical mount paths (see `canonicalPath`) of already-open projects, matched against item ids. */
  excludePaths: ReadonlyArray<string>;
  onBack: () => void;
  onPick: (cwd: string, workerType: ProjectWorkerType) => void;
}> = ({ excludePaths, onBack, onPick }) => {
  const { projects, isLoading } = useAllProjects();
  const [selected, setSelected] = useState<ProjectSelectorItem | null>(null);

  const items = useMemo(() => projectListToSelectorItems(projects), [projects]);

  return (
    <div className="flex h-72 flex-col gap-1" data-testid="projects-counter-picker">
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to open projects"
          className="rounded p-1 hover:bg-muted"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs font-medium text-muted-foreground">Open project</span>
      </div>
      <div className="min-h-0 flex-1">
        <ProjectSelector
          projects={items}
          selectedId={selected?.id ?? null}
          excludeIds={excludePaths}
          isLoading={isLoading}
          emptyMessage="All projects are already open"
          onSelect={(id) => setSelected(id ? (items.find((i) => i.id === id) ?? null) : null)}
        />
      </div>
      {/* Worker toolbar — same buttons as the tab strip's opener toolbar. */}
      <div className="flex shrink-0 items-center gap-1 border-t border-border pt-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
          {selected ? selected.name : 'Select a project'}
        </span>
        {PICKER_WORKERS.map(({ workerType, label, testId, Icon, iconClassName }) => (
          <Button
            key={workerType}
            variant="secondary"
            size="icon"
            className="h-7 w-7 rounded"
            disabled={!selected}
            onClick={() => selected?.path && onPick(selected.path, workerType)}
            aria-label={label}
            title={label}
            data-testid={testId}
          >
            <Icon className={`h-4 w-4 ${iconClassName}`} />
          </Button>
        ))}
      </div>
    </div>
  );
};

export const ProjectsCounterChip: React.FC<ProjectsCounterChipProps> = ({ currentProjectId, onLaunchProjectPath }) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'buckets' | 'picker'>('buckets');
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const { buckets } = useTerminalProjectBuckets();

  const sorted = useMemo(
    () => [...buckets].sort((a, b) => compareBuckets(a, b, currentProjectId)),
    [buckets, currentProjectId],
  );

  const terminalTotal = buckets.reduce((sum, b) => sum + b.tabs.length, 0);
  const projectTotal = buckets.length;
  const isEmpty = projectTotal === 0;
  // With a launch callback the chip stays clickable even with zero buckets —
  // the popover then offers only the "Open another project…" row.
  const isChipDisabled = isEmpty && !onLaunchProjectPath;
  const tooltipText = `${projectTotal} active project${projectTotal === 1 ? '' : 's'} with ${terminalTotal} terminal${
    terminalTotal === 1 ? '' : 's'
  }`;

  // Canonical mount paths of projects already open in the strip — excluded
  // from the picker so it only offers not-yet-open projects.
  const openProjectPaths = useMemo(
    () =>
      buckets
        .map((b) => b.project?.fs_storage_mount_path)
        .filter((p): p is string => !!p)
        .map(canonicalPath),
    [buckets],
  );

  // Per-type icon comes from the backend type registry (TypeInfo.icon) — see
  // CLAUDE.md "Type icons". Resolved at render time so the bootstrap-loaded
  // registry is in place.
  const ProjectTypeIcon = iconForType(Project.type);

  const chipClass = `mx-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium tabular-nums hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-1 focus:ring-ring ${
    isChipDisabled ? 'cursor-default opacity-50 hover:bg-background hover:text-foreground' : ''
  }`;

  if (isChipDisabled) {
    return (
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled
              data-testid="projects-counter-chip"
              className={chipClass}
              aria-label={tooltipText}
            >
              <Layers className="h-3 w-3" />
              {projectTotal}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltipText}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const switchToProject = async (project: Project) => {
    setOpen(false);
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
    dataContext.setWorkdir(project.fs_storage_mount_path ?? null);
  };

  const handleRecover = async (bucket: TerminalProjectBucket) => {
    setRecoveringId(bucket.projectId);
    try {
      const recovered = await bucket.recover();
      if (!recovered) {
        notify.error({
          title: 'Recovery failed',
          message: `Couldn't recover the project for ${bucket.tabs.length} terminal${
            bucket.tabs.length === 1 ? '' : 's'
          } (${bucket.projectId.slice(0, 8)}).`,
          id: `project-recover:${bucket.projectId}`,
        });
        return;
      }
      await switchToProject(recovered);
    } finally {
      setRecoveringId(null);
    }
  };

  const handleSelect = async (bucket: TerminalProjectBucket) => {
    if (bucket.state === 'live' && bucket.project) {
      await switchToProject(bucket.project);
      return;
    }
    if (bucket.state === 'missing') {
      await handleRecover(bucket);
      return;
    }
    // 'loading' — ignore; spinner is rendered in the row.
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setView('buckets');
  };

  const handlePickProjectPath = (cwd: string, workerType: ProjectWorkerType) => {
    handleOpenChange(false);
    void onLaunchProjectPath?.(cwd, workerType);
  };

  return (
    <TooltipProvider delayDuration={400}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button type="button" data-testid="projects-counter-chip" className={chipClass} aria-label={tooltipText}>
                <Layers className="h-3 w-3" />
                {projectTotal}
                <sub className="ml-0.5 text-[9px] leading-none text-muted-foreground">{terminalTotal}</sub>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltipText}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-72 p-1"
          data-testid="projects-counter-popover"
        >
          {view === 'picker' && onLaunchProjectPath ? (
            <ProjectPickerPanel
              excludePaths={openProjectPaths}
              onBack={() => setView('buckets')}
              onPick={handlePickProjectPath}
            />
          ) : (
            <ul className="flex flex-col">
              {sorted.map((bucket) => {
                const isCurrent = bucket.projectId === currentProjectId;
                const isRecovering = recoveringId === bucket.projectId;
                const isMissing = bucket.state === 'missing';
                let leadingIcon: React.ReactNode = null;
                if (isMissing) {
                  leadingIcon = isRecovering ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3 shrink-0" />
                  );
                }
                const rowClass = `flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                  isCurrent ? 'bg-muted/60 font-medium' : ''
                } ${isMissing ? 'text-muted-foreground' : ''}`;
                return (
                  <li key={bucket.projectId}>
                    <button
                      type="button"
                      aria-current={isCurrent ? 'true' : undefined}
                      disabled={bucket.state === 'loading' || isRecovering}
                      onClick={() => handleSelect(bucket)}
                      className={rowClass}
                    >
                      {leadingIcon}
                      <span className="min-w-0 flex-1 truncate">{bucketRowLabel(bucket)}</span>
                      {isMissing && !isRecovering ? (
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                          recover
                        </span>
                      ) : null}
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                        {bucket.tabs.length}
                      </span>
                    </button>
                  </li>
                );
              })}
              {onLaunchProjectPath ? (
                // "Open another project…" — same row anatomy as the buckets
                // above, but visually set apart: a wider gap with a horizontal
                // rule, and a subtle dashed border marking it as an action
                // rather than an open project.
                <li className={isEmpty ? '' : 'mt-2 border-t border-border pt-2'}>
                  <button
                    type="button"
                    data-testid="projects-counter-open-other"
                    onClick={() => setView('picker')}
                    className="flex w-full items-center gap-2 rounded-md border border-dashed border-border/80 px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <ProjectTypeIcon className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">Open another project…</span>
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
};
