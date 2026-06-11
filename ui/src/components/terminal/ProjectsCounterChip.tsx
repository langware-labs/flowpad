import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { canonicalPath, projectListToSelectorItems, ProjectSelector } from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { notify } from '@src/notifications';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { useTerminalProjectBuckets, type TerminalProjectBucket } from '@src/tabs/useTabs';
import { ChevronLeft, History, Layers, Loader2, RotateCcw } from 'lucide-react';
import React, { useMemo, useState } from 'react';

/** Agentic worker kinds offered by the picker's worker toolbar. */
export type ProjectWorkerType = 'claude_code' | 'codex' | 'copilot';

interface ProjectsCounterChipProps {
  /** Project that the surrounding tab strip is currently scoped to. Used to highlight that row. */
  currentProjectId?: string | null;
  /**
   * When provided, the action strip below the bucket list carries one icon
   * button per worker type. Clicking a worker opens the embedded picker with
   * that worker armed; picking a project immediately calls this with the
   * project's filesystem path and the armed worker type. The host owns
   * ensure + launch.
   */
  onLaunchProjectPath?: (cwd: string, workerType: ProjectWorkerType) => void | Promise<void>;
  /**
   * When provided, the action strip gains a history icon button — yet another
   * way to reopen a past session. Clicking it closes the popover and calls
   * this; the host owns the history modal.
   */
  onOpenHistory?: () => void;
}

function bucketDisplayName(bucket: TerminalProjectBucket): string {
  return bucket.project?.getDisplayName() ?? bucket.project?.name ?? bucket.projectId;
}

// Sort: alphabetical by display name, projectId tie-break. Deliberately NOT
// current-first or state-ranked — the list keeps a stable order as the user
// switches projects or buckets change state; the current row is highlighted
// instead of moved.
function compareBuckets(a: TerminalProjectBucket, b: TerminalProjectBucket): number {
  return (
    bucketDisplayName(a).localeCompare(bucketDisplayName(b)) || a.projectId.localeCompare(b.projectId)
  );
}

function bucketRowLabel(bucket: TerminalProjectBucket): string {
  if (bucket.state === 'live') return bucketDisplayName(bucket);
  if (bucket.state === 'loading') return 'Loading…';
  return `Project unavailable (${bucket.projectId.slice(0, 8)})`;
}

// Worker entries for the action strip — mirrors the tab strip's opener
// buttons.
interface PickerWorker {
  workerType: ProjectWorkerType;
  name: string;
  testId: string;
  Icon: React.ComponentType<{ className?: string }>;
  iconClassName: string;
}

const PICKER_WORKERS: PickerWorker[] = [
  {
    workerType: 'claude_code',
    name: 'Claude Code',
    testId: 'projects-counter-open-claude',
    Icon: ClaudeIcon,
    iconClassName: 'text-orange-500',
  },
  {
    workerType: 'codex',
    name: 'Codex',
    testId: 'projects-counter-open-codex',
    Icon: CodexIcon,
    iconClassName: 'text-emerald-500',
  },
  {
    workerType: 'copilot',
    name: 'Copilot',
    testId: 'projects-counter-open-copilot',
    Icon: CopilotIcon,
    iconClassName: 'text-sky-500',
  },
];

/**
 * Picker panel shown after a worker icon on the action strip is clicked.
 * Mounted only then, so its data hooks (compute-node project
 * scan) never run for the plain counter chip. Projects that already have an
 * open bucket in the strip are excluded. The worker is already armed —
 * picking a project launches it immediately (one click).
 */
const ProjectPickerPanel: React.FC<{
  /** The armed worker — picking a project opens it with this worker. */
  worker: PickerWorker;
  /** Canonical mount paths (see `canonicalPath`) of already-open projects, matched against item ids. */
  excludePaths: ReadonlyArray<string>;
  onBack: () => void;
  onPick: (cwd: string) => void;
}> = ({ worker, excludePaths, onBack, onPick }) => {
  const { projects, isLoading } = useAllProjects();

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
        <worker.Icon className={`h-3.5 w-3.5 shrink-0 ${worker.iconClassName}`} />
        <span className="text-xs font-medium text-muted-foreground">Open {worker.name} on…</span>
      </div>
      <div className="min-h-0 flex-1">
        <ProjectSelector
          projects={items}
          selectedId={null}
          excludeIds={excludePaths}
          isLoading={isLoading}
          emptyMessage="All projects are already open"
          onSelect={(id) => {
            if (!id) return;
            const picked = items.find((i) => i.id === id);
            if (picked?.path) onPick(picked.path);
          }}
        />
      </div>
    </div>
  );
};

export const ProjectsCounterChip: React.FC<ProjectsCounterChipProps> = ({
  currentProjectId,
  onLaunchProjectPath,
  onOpenHistory,
}) => {
  const [open, setOpen] = useState(false);
  // Non-null while the picker is shown; carries the worker armed by the
  // clicked icon on the action strip.
  const [pickerWorker, setPickerWorker] = useState<PickerWorker | null>(null);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const { buckets } = useTerminalProjectBuckets();

  const sorted = useMemo(() => [...buckets].sort(compareBuckets), [buckets]);

  const terminalTotal = buckets.reduce((sum, b) => sum + b.tabs.length, 0);
  const projectTotal = buckets.length;
  const isEmpty = projectTotal === 0;
  // With an action callback the chip stays clickable even with zero buckets —
  // the popover then offers only the action rows.
  const isChipDisabled = isEmpty && !onLaunchProjectPath && !onOpenHistory;
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
    if (!next) setPickerWorker(null);
  };

  const handlePickProjectPath = (cwd: string) => {
    const workerType = pickerWorker?.workerType;
    handleOpenChange(false);
    if (workerType) void onLaunchProjectPath?.(cwd, workerType);
  };

  // Action strip contents — one entry per worker (arms the picker) plus the
  // history opener, gated by the host-provided callbacks. A single list so
  // every action renders through the same icon-button markup below.
  const stripActions = [
    ...(onLaunchProjectPath
      ? PICKER_WORKERS.map((worker) => ({
          key: worker.workerType as string,
          Icon: worker.Icon,
          iconClassName: worker.iconClassName,
          label: `Open ${worker.name} on another project`,
          testId: worker.testId,
          onClick: () => setPickerWorker(worker),
        }))
      : []),
    ...(onOpenHistory
      ? [
          {
            key: 'history',
            Icon: History,
            iconClassName: '',
            label: 'Open from history',
            testId: 'projects-counter-open-history',
            onClick: () => {
              handleOpenChange(false);
              onOpenHistory();
            },
          },
        ]
      : []),
  ];

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
          {pickerWorker && onLaunchProjectPath ? (
            <ProjectPickerPanel
              worker={pickerWorker}
              excludePaths={openProjectPaths}
              onBack={() => setPickerWorker(null)}
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
              {stripActions.length ? (
                // Action strip — compact icon buttons set apart from the
                // bucket rows by a horizontal rule, no label line. Worker
                // icons open the project picker with that worker armed
                // (picking a project launches it immediately); the history
                // icon reopens a past session (the host owns the modal).
                // Meaning is carried by tooltips/aria-labels.
                <li className={isEmpty ? '' : 'mt-2 border-t border-border pt-2'}>
                  <div
                    data-testid="projects-counter-actions"
                    className="flex w-full items-center justify-center gap-2 px-2 py-1"
                  >
                    {stripActions.map((action) => (
                      <Button
                        key={action.key}
                        variant="secondary"
                        size="icon"
                        className="h-7 w-7 shrink-0 rounded"
                        onClick={action.onClick}
                        aria-label={action.label}
                        title={action.label}
                        data-testid={action.testId}
                      >
                        <action.Icon className={`h-4 w-4 ${action.iconClassName}`} />
                      </Button>
                    ))}
                  </div>
                </li>
              ) : null}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
};
