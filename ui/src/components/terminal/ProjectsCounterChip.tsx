import { Trans, useLingui } from '@lingui/react/macro';
import { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { WorkerToolbar } from '@src/components/workers/WorkerToolbar';
import type { WorkerType } from '@src/components/workers/worker-types';
import {
  workerIcon,
  workerLabel,
} from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { canonicalPath, projectListToSelectorItems, ProjectSelector } from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dockForGlobalEntry, dockForProjectEntry } from '@src/tabs/project-entry';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { useTabProjectBuckets, type TabProjectBucket } from '@src/tabs/useTabs';
import { ChevronLeft, Globe, History, Layers, Loader2, RotateCcw } from 'lucide-react';
import React, { useMemo, useState } from 'react';

/** Agentic worker kinds offered by the picker's worker toolbar. Alias of the
 *  shared {@link WorkerType} (re-exported so the host can use it by name). */
export type ProjectWorkerType = WorkerType;

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

/**
 * Hairline-flanked mid-list section title — the chip's "Active projects"
 * separator. Exported so other project lists (the footer Switch Project
 * dialog) render the identical separator instead of a lookalike.
 */
export function SectionHairlineTitle({
  children,
  testid = 'projects-counter-section-title',
}: {
  children: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="flex items-center gap-2 px-2 pb-0.5 pt-1.5" data-testid={testid}>
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {children}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
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
/**
 * Picker panel shown after a worker icon on the action strip is clicked.
 * Mounted only then, so its data hooks (compute-node project
 * scan) never run for the plain counter chip. Projects that already have an
 * open bucket in the strip are excluded. The worker is already armed —
 * picking a project launches it immediately (one click).
 */
const ProjectPickerPanel: React.FC<{
  /** The armed worker — picking a project opens it with this worker. */
  worker: ProjectWorkerType;
  /** Canonical mount paths (see `canonicalPath`) of already-open projects, matched against item ids. */
  excludePaths: ReadonlyArray<string>;
  onBack: () => void;
  onPick: (cwd: string) => void;
}> = ({ worker, excludePaths, onBack, onPick }) => {
  const { t } = useLingui();
  const WorkerIcon = workerIcon(worker);
  const { projects, isLoading } = useAllProjects();

  const items = useMemo(() => projectListToSelectorItems(projects), [projects]);

  return (
    <div className="flex h-72 flex-col gap-1" data-testid="projects-counter-picker">
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onBack}
          aria-label={t`Back to open projects`}
          className="rounded p-1 hover:bg-muted"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <WorkerIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="text-xs font-medium text-muted-foreground"><Trans>Open {workerLabel(worker)} on…</Trans></span>
      </div>
      <div className="min-h-0 flex-1">
        <ProjectSelector
          projects={items}
          selectedId={null}
          excludeIds={excludePaths}
          isLoading={isLoading}
          emptyMessage={t`All projects are already open`}
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
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // Non-null while the picker is shown; carries the worker armed by the
  // clicked icon on the action strip.
  const [pickerWorker, setPickerWorker] = useState<ProjectWorkerType | null>(null);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const { navigation } = useDockNavigation();
  const { buckets, globalTabCount } = useTabProjectBuckets();

  const sorted = useMemo(() => [...buckets].sort(compareBuckets), [buckets]);

  const tabTotal = buckets.reduce((sum, b) => sum + b.tabCount, 0);
  const projectTotal = buckets.length;

  // Name of the current project, shown as a label segment on the chip.
  const projectName = useMemo(
    () => resolveProjectChipName(currentProjectName, currentProjectId, buckets),
    [currentProjectName, currentProjectId, buckets],
  );
  const hasProject = !!projectName;
  // The Global scope surfaces ONLY when no project is active AND there is ≥1
  // global tab (strictly current-only — you enter Global by opening a global
  // tab, not by picking it from within a project). It is then always the current
  // scope: a violet "Global" label + a current-marked row above the projects.
  const isGlobalScope = currentProjectId == null && globalTabCount > 0;
  // The active scope's label — a project name, or "Global" — or null when the
  // chip is a bare counter. `scopeLabel != null` is the single "chip carries a
  // label" predicate used for both styling and the counts muting.
  const scopeLabel = hasProject ? projectName : isGlobalScope ? 'Global' : null;
  // Nothing to advertise: no project owns a tab and we're not in a populated
  // Global scope. A bare "0 / 0" chip represents nothing, so it stays hidden.
  const isEmpty = projectTotal === 0 && !isGlobalScope;

  const countTooltip = `${projectTotal} active project${projectTotal === 1 ? '' : 's'} with ${tabTotal} open tab${
    tabTotal === 1 ? '' : 's'
  }`;
  const tooltipText = scopeLabel ? `${scopeLabel} — ${countTooltip}` : countTooltip;

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

  // Three scope treatments, all within the same design language (height, radius,
  // border weight): a PROJECT scope reads as a subtle primary-tinted pill; the
  // GLOBAL scope gets a distinct violet accent so it never looks like a regular
  // project; a scope-less strip falls back to the plain neutral chip so it isn't
  // washed in accent color.
  const chipClass = `mx-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium tabular-nums focus:outline-none focus:ring-1 focus:ring-ring ${
    hasProject
      ? 'border-primary/30 bg-primary/5 text-foreground hover:bg-primary/10'
      : isGlobalScope
        ? 'border-violet-500/30 bg-violet-500/5 text-foreground hover:bg-violet-500/10'
        : 'border-border bg-background hover:bg-accent hover:text-accent-foreground'
  }`;

  // Per-type icon from the backend TypeInfo registry (CLAUDE.md: never hardcode
  // a glyph for an entity type) — the same project icon every other surface shows.
  // Global is a pseudo-scope (not an entity type), so it uses a plain `Globe` glyph.
  const ProjectIcon = iconForType(Project.type);

  // Shared trigger content: the scope label (project name, or "Global") followed
  // by the open-projects / tabs counts. The label is the hero (accent glyph,
  // foreground weight); the counts ride along muted and divided off.
  const triggerContent = (
    <>
      {hasProject ? (
        <>
          <ProjectIcon className="h-3 w-3 shrink-0 text-primary" />
          <span className="max-w-[9rem] truncate">{projectName}</span>
          <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-border" />
        </>
      ) : isGlobalScope ? (
        <>
          <Globe className="h-3 w-3 shrink-0 text-violet-500" />
          <span className="max-w-[9rem] truncate"><Trans>Global</Trans></span>
          <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-border" />
        </>
      ) : null}
      <Layers className={`h-3 w-3 shrink-0 ${scopeLabel != null ? 'text-muted-foreground' : ''}`} />
      <span className={scopeLabel != null ? 'text-muted-foreground' : undefined}>{projectTotal}</span>
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
          title: t`Recovery failed`,
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

  // Selecting the Global row re-focuses the Global scope (it's only shown while
  // Global is already current). URL-first: resolve the most-recently-active
  // global tab (or Home) and navigate; the loader re-scopes off the URL.
  const handleSelectGlobal = async () => {
    setOpen(false);
    navigation.openDock(await dockForGlobalEntry());
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setPickerWorker(null);
  };

  const handlePickProjectPath = (cwd: string) => {
    const workerType = pickerWorker;
    handleOpenChange(false);
    if (workerType) void onLaunchProjectPath?.(cwd, workerType);
  };

  const hasActions = !!onLaunchProjectPath || !!onOpenHistory;

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
              {isGlobalScope ? (
                // The Global scope row — violet-accented so it never reads as a
                // regular project, and always the current scope when shown.
                <li key="__global__">
                  <button
                    type="button"
                    aria-current="true"
                    onClick={() => void handleSelectGlobal()}
                    className="flex w-full items-center gap-2 rounded bg-violet-500/10 px-2 py-1.5 text-left text-sm font-medium hover:bg-violet-500/15"
                    data-testid="projects-counter-global"
                  >
                    <Globe className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                    <span className="min-w-0 flex-1 truncate text-violet-600 dark:text-violet-300">
                      <Trans>Global</Trans>
                    </span>
                    <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-xs tabular-nums text-violet-600 dark:text-violet-300">
                      {globalTabCount}
                    </span>
                  </button>
                </li>
              ) : null}
              {isGlobalScope && sorted.length > 0 ? (
                // Small mid-title separating the Global row from the project
                // buckets below it.
                <li key="__projects_title__" aria-hidden>
                  <SectionHairlineTitle>
                    <Trans>Active projects</Trans>
                  </SectionHairlineTitle>
                </li>
              ) : null}
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
                          <Trans>recover</Trans>
                        </span>
                      ) : null}
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                        {bucket.tabCount}
                      </span>
                    </button>
                  </li>
                );
              })}
              {hasActions ? (
                // Action strip — compact icon buttons set apart from the
                // bucket rows by a horizontal rule, no label line. Worker
                // icons (shared WorkerToolbar) open the project picker with
                // that worker armed (picking a project launches it
                // immediately); the history icon reopens a past session (the
                // host owns the modal). Meaning is carried by tooltips/aria.
                <li className={isEmpty ? '' : 'mt-2 border-t border-border pt-2'}>
                  <div
                    data-testid="projects-counter-actions"
                    className="flex w-full items-center justify-center gap-2 px-2 py-1"
                  >
                    {onLaunchProjectPath && (
                      <WorkerToolbar
                        onLaunch={(worker) => setPickerWorker(worker)}
                        testIdPrefix="projects-counter-open"
                      />
                    )}
                    {onOpenHistory && (
                      <Button
                        variant="secondary"
                        size="icon"
                        className="h-7 w-7 shrink-0 rounded"
                        onClick={() => {
                          handleOpenChange(false);
                          onOpenHistory();
                        }}
                        aria-label={t`Open from history`}
                        title={t`Open from history`}
                        data-testid="projects-counter-open-history"
                      >
                        <History className="h-4 w-4" />
                      </Button>
                    )}
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
