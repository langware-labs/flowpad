import { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { canonicalPath, projectListToSelectorItems, ProjectSelector } from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dockForProjectEntry } from '@src/tabs/project-entry';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { useTabProjectBuckets, type TabProjectBucket } from '@src/tabs/useTabs';
import { ChevronLeft, History, Layers, Loader2, RotateCcw } from 'lucide-react';
import React, { useMemo, useState } from 'react';

/** Agentic worker kinds offered by the picker's worker toolbar. */
export type ProjectWorkerType = 'claude_code' | 'codex' | 'copilot';

interface ProjectsCounterChipProps {
  /** Project that the surrounding tab strip is currently scoped to. Used to highlight that row. */
  currentProjectId?: string | null;
  /**
   * Display name of the current project, shown as a chip alongside the counts.
   * Optional: the chip falls back to the matching open bucket's name, so a
   * project with live terminals still labels itself even without this prop.
   */
  currentProjectName?: string | null;
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

function bucketDisplayName(bucket: TabProjectBucket): string {
  return bucket.project?.getDisplayName() ?? bucket.project?.name ?? bucket.projectId;
}

/**
 * Name shown on the chip's project label. Prefer the explicit current-project
 * name; otherwise fall back to the matching open bucket's display name so a
 * project with live terminals still labels itself even without the prop.
 * Returns null when no project is known (the chip then shows counts only).
 * Pure + dependency-free so it's unit-testable in isolation.
 */
export function resolveProjectChipName(
  currentProjectName: string | null | undefined,
  currentProjectId: string | null | undefined,
  buckets: ReadonlyArray<TabProjectBucket>,
): string | null {
  if (currentProjectName?.trim()) return currentProjectName.trim();
  const bucket = currentProjectId ? buckets.find((b) => b.projectId === currentProjectId) : null;
  return bucket ? bucketDisplayName(bucket) : null;
}

// Sort: alphabetical by display name, projectId tie-break. Deliberately NOT
// current-first or state-ranked — the list keeps a stable order as the user
// switches projects or buckets change state; the current row is highlighted
// instead of moved.
function compareBuckets(a: TabProjectBucket, b: TabProjectBucket): number {
  return (
    bucketDisplayName(a).localeCompare(bucketDisplayName(b)) || a.projectId.localeCompare(b.projectId)
  );
}

function bucketRowLabel(bucket: TabProjectBucket): string {
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
  currentProjectName,
  onLaunchProjectPath,
  onOpenHistory,
}) => {
  const [open, setOpen] = useState(false);
  // Non-null while the picker is shown; carries the worker armed by the
  // clicked icon on the action strip.
  const [pickerWorker, setPickerWorker] = useState<PickerWorker | null>(null);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const { navigation } = useDockNavigation();
  const { buckets } = useTabProjectBuckets();

  const sorted = useMemo(() => [...buckets].sort(compareBuckets), [buckets]);

  const tabTotal = buckets.reduce((sum, b) => sum + b.tabCount, 0);
  const projectTotal = buckets.length;
  const isEmpty = projectTotal === 0;

  // Name of the current project, shown as a label segment on the chip.
  const projectName = useMemo(
    () => resolveProjectChipName(currentProjectName, currentProjectId, buckets),
    [currentProjectName, currentProjectId, buckets],
  );
  const hasProject = !!projectName;

  const countTooltip = `${projectTotal} active project${projectTotal === 1 ? '' : 's'} with ${tabTotal} open tab${
    tabTotal === 1 ? '' : 's'
  }`;
  const tooltipText = hasProject ? `${projectName} — ${countTooltip}` : countTooltip;

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

  // When the chip carries a project name it reads as the "project context"
  // pill — a subtle primary tint + accent border sets it apart from the neutral
  // tab headers next to it, while staying within the design language (same
  // height, radius, border weight). Without a project it falls back to the
  // plain neutral chip so a project-less strip isn't washed in accent color.
  const chipClass = `mx-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium tabular-nums focus:outline-none focus:ring-1 focus:ring-ring ${
    hasProject
      ? 'border-primary/30 bg-primary/5 text-foreground hover:bg-primary/10'
      : 'border-border bg-background hover:bg-accent hover:text-accent-foreground'
  }`;

  // Per-type icon from the backend TypeInfo registry (CLAUDE.md: never hardcode
  // a glyph for an entity type) — the same project icon every other surface shows.
  const ProjectIcon = iconForType(Project.type);

  // Shared trigger content: the project-name label (when known) followed by the
  // open-projects / terminals counts. The name is the hero (primary glyph,
  // foreground weight); the counts ride along muted and divided off.
  const triggerContent = (
    <>
      {hasProject ? (
        <>
          <ProjectIcon className="h-3 w-3 shrink-0 text-primary" />
          <span className="max-w-[9rem] truncate">{projectName}</span>
          <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-border" />
        </>
      ) : null}
      <Layers className={`h-3 w-3 shrink-0 ${hasProject ? 'text-muted-foreground' : ''}`} />
      <span className={hasProject ? 'text-muted-foreground' : undefined}>{projectTotal}</span>
      <sub className="ml-0.5 text-[9px] leading-none text-muted-foreground">{tabTotal}</sub>
    </>
  );

  // No project owns any open tab (buckets empty ⇒ both counts are 0). Even when
  // an ambient active project still resolves a name, a "<project> · 0 / 0" chip
  // represents nothing — a strip whose only tabs are global has no project tab
  // to count — so the chip stays hidden rather than advertising "0,0".
  if (isEmpty) return null;

  const handleRecover = async (bucket: TabProjectBucket) => {
    setRecoveringId(bucket.projectId);
    try {
      const recovered = await bucket.recover();
      if (!recovered) {
        notify.error({
          title: 'Recovery failed',
          message: `Couldn't recover the project for ${bucket.tabCount} open tab${
            bucket.tabCount === 1 ? '' : 's'
          } (${bucket.projectId.slice(0, 8)}).`,
          id: `project-recover:${bucket.projectId}`,
        });
        return;
      }
      setOpen(false);
      navigation.openDock(await dockForProjectEntry(recovered.id));
    } finally {
      setRecoveringId(null);
    }
  };

  // Selecting a project is an active-project switch. URL-first (CLAUDE.md): the
  // click only resolves a destination and navigates — it resumes the project's
  // most-recently-active tab (or its landing when it has none) via
  // `dockForProjectEntry`. The loader that the navigation triggers is the single
  // writer of project context; the strip re-scopes off the URL-resolved project.
  const handleSelect = async (bucket: TabProjectBucket) => {
    if (bucket.state === 'missing') {
      await handleRecover(bucket);
      return;
    }
    if (bucket.state === 'live' && bucket.project) {
      setOpen(false);
      navigation.openDock(await dockForProjectEntry(bucket.project.id));
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
                {triggerContent}
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
                      onClick={() => void handleSelect(bucket)}
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
                        {bucket.tabCount}
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
