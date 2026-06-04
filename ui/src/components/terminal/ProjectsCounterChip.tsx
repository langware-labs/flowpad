import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { notify } from '@src/notifications';
import { useTerminalProjectBuckets, type TerminalProjectBucket } from '@src/hooks/useActiveTerminals';
import { Layers, Loader2, RotateCcw } from 'lucide-react';
import React, { useMemo, useState } from 'react';

interface ProjectsCounterChipProps {
  /** Project that the surrounding tab strip is currently scoped to. Used to highlight that row. */
  currentProjectId?: string | null;
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
  const currentDiff =
    Number(b.projectId === currentProjectId) - Number(a.projectId === currentProjectId);
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

export const ProjectsCounterChip: React.FC<ProjectsCounterChipProps> = ({ currentProjectId }) => {
  const [open, setOpen] = useState(false);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const { buckets } = useTerminalProjectBuckets();

  const sorted = useMemo(
    () => [...buckets].sort((a, b) => compareBuckets(a, b, currentProjectId)),
    [buckets, currentProjectId],
  );

  const terminalTotal = buckets.reduce((sum, b) => sum + b.tabs.length, 0);
  const projectTotal = buckets.length;
  const isEmpty = projectTotal === 0;
  const tooltipText = `${projectTotal} active project${projectTotal === 1 ? '' : 's'} with ${terminalTotal} terminal${
    terminalTotal === 1 ? '' : 's'
  }`;

  const chipClass = `mx-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium tabular-nums hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-1 focus:ring-ring ${
    isEmpty ? 'cursor-default opacity-50 hover:bg-background hover:text-foreground' : ''
  }`;

  if (isEmpty) {
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
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      project.typeId,
    );
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

  return (
    <TooltipProvider delayDuration={400}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="projects-counter-chip"
                className={chipClass}
                aria-label={tooltipText}
              >
                <Layers className="h-3 w-3" />
                {projectTotal}
                <sub className="ml-0.5 text-[9px] leading-none text-muted-foreground">
                  {terminalTotal}
                </sub>
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
          <ul className="flex flex-col">
            {sorted.map((bucket) => {
              const isCurrent = bucket.projectId === currentProjectId;
              const isRecovering = recoveringId === bucket.projectId;
              const isMissing = bucket.state === 'missing';
              let leadingIcon: React.ReactNode = null;
              if (isMissing) {
                leadingIcon = isRecovering
                  ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  : <RotateCcw className="h-3 w-3 shrink-0" />;
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
          </ul>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
};
