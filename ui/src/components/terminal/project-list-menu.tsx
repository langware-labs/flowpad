import { Trans, useLingui } from '@lingui/react/macro';
import { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { canonicalPath } from '@src/components/project-selector';
import { useProjects } from '@src/hooks/use-projects';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dockForGlobalEntry, dockForProjectEntry } from '@src/tabs/project-entry';
import { useTabProjectBuckets, type TabProjectBucket } from '@src/tabs/use-tab-manager';
import { FolderOpen, Globe, Loader2, RotateCcw, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';

/**
 * THE project list — the "which open project am I in, and which can I switch
 * to" menu — as a headless hook plus the list it renders. The navigation bar's
 * {@link RuntimeChip} wears it: the chip owns its trigger, Popover and testids;
 * the buckets, ordering, counts and URL-first selection live here, once.
 */

function bucketDisplayName(bucket: TabProjectBucket): string {
  return bucket.project?.displayName ?? bucket.projectId;
}

/**
 * Name shown on the chip's project label. Prefer the explicit current-project
 * name; otherwise fall back to the matching open bucket's display name (the
 * project entity may not have resolved one yet). Returns null when no project
 * is known. Pure + dependency-free so it's unit-testable in isolation.
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
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

// Sort: alphabetical by display name, projectId tie-break. Deliberately NOT
// current-first or state-ranked — the list keeps a stable order as the user
// switches projects or buckets change state; the current row is highlighted
// instead of moved.
function compareBuckets(a: TabProjectBucket, b: TabProjectBucket): number {
  return bucketDisplayName(a).localeCompare(bucketDisplayName(b)) || a.projectId.localeCompare(b.projectId);
}

function bucketRowLabel(bucket: TabProjectBucket): string {
  if (bucket.state === 'live') return bucketDisplayName(bucket);
  if (bucket.state === 'loading') return 'Loading…';
  return `Project unavailable (${bucket.projectId.slice(0, 8)})`;
}

/**
 * True when `childPath` names a location strictly INSIDE `parentPath` — the
 * containment test that makes one project a subproject of another. Both inputs
 * pass through {@link canonicalPath} first, so this is cross-platform: `\` →
 * `/`, and trailing / duplicate separators are normalized away. The compare is
 * case-insensitive so grouping is correct on case-insensitive filesystems
 * (Windows, macOS) and remains safe on Linux for this display-only feature. The
 * trailing-separator boundary stops `/foo/bar` from reading as inside
 * `/foo/barn`. Pure + dependency-free so it's unit-testable in isolation.
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
  const child = canonicalPath(childPath).toLowerCase();
  const parent = canonicalPath(parentPath).toLowerCase();
  if (!child || !parent || child === parent) return false;
  return child.startsWith(`${parent}/`);
}

/** One indentation column of a tree row: a pass-through vertical, the elbow that
 *  connects a child to its parent (last child stops the vertical at center), or
 *  blank space where an ancestor branch has already ended. */
type GuideCell = 'blank' | 'through' | 'elbow' | 'elbow-last';

/** A menu row plus the tree-guide columns to draw at its left (empty = top level). */
export interface ProjectTreeRow {
  bucket: TabProjectBucket;
  guides: GuideCell[];
}

/**
 * Arrange open project buckets into parent → subproject render order for the
 * menu. A bucket is a SUBPROJECT of another when its mount path lives inside
 * that other bucket's mount path (deepest enclosing open project wins as the
 * parent). This is a pure DISPLAY grouping — no entity/graph relationship is
 * created or implied. Buckets without a resolved path (loading / missing) can't
 * be contained, so they stay top-level. Siblings at every level keep the flat
 * {@link compareBuckets} order; a subproject stays nested under its parent
 * regardless of which one is the current scope. Returns rows in render order,
 * each carrying the guide columns for its depth.
 */
export function buildProjectTreeRows(buckets: ReadonlyArray<TabProjectBucket>): ProjectTreeRow[] {
  const paths = new Map<string, string>(); // projectId -> canonical mount path
  for (const b of buckets) {
    const mount = b.project?.fs_storage_mount_path;
    if (mount) paths.set(b.projectId, canonicalPath(mount));
  }

  // Each pathed bucket's parent = the DEEPEST other pathed bucket that contains
  // it (longest matching parent path wins for correct multi-level nesting).
  const parentId = new Map<string, string>();
  for (const b of buckets) {
    const childPath = paths.get(b.projectId);
    if (!childPath) continue;
    let best: { id: string; len: number } | null = null;
    for (const other of buckets) {
      if (other.projectId === b.projectId) continue;
      const parentPath = paths.get(other.projectId);
      if (parentPath && isPathInside(childPath, parentPath) && (!best || parentPath.length > best.len)) {
        best = { id: other.projectId, len: parentPath.length };
      }
    }
    if (best) parentId.set(b.projectId, best.id);
  }

  // Children index + roots, each sibling list in the flat compareBuckets order.
  const childrenOf = new Map<string, TabProjectBucket[]>();
  const roots: TabProjectBucket[] = [];
  for (const b of [...buckets].sort(compareBuckets)) {
    const pid = parentId.get(b.projectId);
    if (!pid) {
      roots.push(b);
      continue;
    }
    const siblings = childrenOf.get(pid);
    if (siblings) siblings.push(b);
    else childrenOf.set(pid, [b]);
  }

  // Depth-first flatten, carrying the guide columns down each branch.
  const rows: ProjectTreeRow[] = [];
  const walkChildren = (ownerId: string, prefix: GuideCell[]) => {
    const kids = childrenOf.get(ownerId) ?? [];
    kids.forEach((kid, i) => {
      const isLast = i === kids.length - 1;
      rows.push({ bucket: kid, guides: [...prefix, isLast ? 'elbow-last' : 'elbow'] });
      walkChildren(kid.projectId, [...prefix, isLast ? 'blank' : 'through']);
    });
  };
  for (const root of roots) {
    rows.push({ bucket: root, guides: [] });
    walkChildren(root.projectId, []);
  }
  return rows;
}

/** Left-edge tree guides for one menu row (file-explorer style). Each column is
 *  a 16px cell; verticals connect flush across adjacent rows because the row
 *  buttons stack with no gap. Purely decorative, so `aria-hidden`. */
function RowGuides({ guides }: { guides: GuideCell[] }) {
  if (guides.length === 0) return null;
  return (
    <span aria-hidden className="flex shrink-0 self-stretch">
      {guides.map((cell, i) => (
        <span key={i} className="relative w-4 self-stretch">
          {cell === 'through' || cell === 'elbow' ? (
            <span className="absolute bottom-0 left-2 top-0 w-px bg-border" />
          ) : null}
          {cell === 'elbow-last' ? <span className="absolute left-2 top-0 h-1/2 w-px bg-border" /> : null}
          {cell === 'elbow' || cell === 'elbow-last' ? (
            <span className="absolute left-2 top-1/2 h-px w-2 bg-border" />
          ) : null}
        </span>
      ))}
    </span>
  );
}

interface ProjectListMenuOptions {
  /** The scope the surrounding surface is in; highlights that row and decides Global. */
  currentProjectId?: string | null;
  /** Display name of the current project. Optional: the menu falls back to the
   *  matching open bucket's name when the entity hasn't resolved one. */
  currentProjectName?: string | null;
}

export interface ProjectListMenu {
  /** Whether the list popover is showing. The trigger's Popover is controlled by this. */
  open: boolean;
  setOpen: (open: boolean) => void;
  currentProjectId: string | null;
  /** Open project buckets with system projects filtered out, in arrival order. */
  buckets: TabProjectBucket[];
  projectTotal: number;
  globalTabCount: number;
  /** No project is current AND ≥1 global tab is open — strictly current-only. */
  isGlobalScope: boolean;
  /** The current project's name, or null when no project is known. */
  projectName: string | null;
  /** The active scope's label — the project name, or "Global" — or null when
   *  there is no scope to name. */
  scopeLabel: string | null;
  /** "N open project(s)" — one line, used by tooltips and aria-labels alike. */
  projectsLabel: string;
  /** "N open tab(s)". */
  tabsLabel: string;
  /** The scope and both counts on one line, for a flat aria-label. */
  recoveringId: string | null;
  /** The bucket whose close-all is in flight, or null. */
  closingId: string | null;
  handleSelect: (bucket: TabProjectBucket) => Promise<void>;
  handleSelectGlobal: () => Promise<void>;
  /** Close every tab of `bucket`, which is what empties it out of the menu. */
  handleCloseProject: (bucket: TabProjectBucket) => Promise<void>;
  /** Whether the "Open project" dialog (the footer's Switch Project picker) is showing. */
  projectDialogOpen: boolean;
  setProjectDialogOpen: (open: boolean) => void;
  /** Close the list and pop the "Open project" dialog. */
  handleOpenProject: () => void;
}

/** The project list's state and actions, trigger-agnostic. */
export function useProjectListMenu({
  currentProjectId = null,
  currentProjectName,
}: ProjectListMenuOptions): ProjectListMenu {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const { currentDock, navigation } = useDockNavigation();
  const { buckets: allBuckets, globalTabCount } = useTabProjectBuckets();

  // System projects (e.g. the shipped "Flowpad Assistant") are kept out of the
  // chip entirely — they stay reachable via Preferences → UI → "Show system
  // projects". We read the backend-computed `system` flag off the entity rather
  // than re-deriving it client-side. A bucket whose entity is still loading
  // (project == null) is kept — it resolves from cache and re-filters once known.
  // The agent mount ROOT (~/Flowpad workspace) is excluded on the backend
  // (never minted, never listed), so no new tab can open on it here.
  const buckets = useMemo(() => allBuckets.filter((b) => !b.project?.system), [allBuckets]);

  const tabTotal = buckets.reduce((sum, b) => sum + b.tabCount, 0);
  const projectTotal = buckets.length;

  const projectName = useMemo(
    () => resolveProjectChipName(currentProjectName, currentProjectId, buckets),
    [currentProjectName, currentProjectId, buckets],
  );

  // The Global scope surfaces ONLY when no project is active AND there is ≥1
  // global tab (strictly current-only — you enter Global by opening a global
  // tab, not by picking it from within a project). It is then always the current
  // scope: a violet "Global" label + a current-marked row above the projects.
  const isGlobalScope = currentProjectId == null && globalTabCount > 0;

  // Spelled-out, singular-aware labels for each count — used both in the
  // hover tooltip (one line each so it's unmistakable which number is which)
  // and, joined, in the flat aria-label.
  const projectsLabel = `${projectTotal} open project${projectTotal === 1 ? '' : 's'}`;
  const tabsLabel = `${tabTotal} open tab${tabTotal === 1 ? '' : 's'}`;
  const scopeLabel = projectName ?? (isGlobalScope ? 'Global' : null);

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
      navigation.openDock(await dockForProjectEntry(recovered.id, currentDock));
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
      navigation.openDock(await dockForProjectEntry(bucket.project.id, currentDock));
    }
    // 'loading' — ignore; spinner is rendered in the row.
  };

  // Close every tab of one project — the row's X, and the same verb as the
  // strip's "Close all" applied to a bucket instead of the current scope. The
  // row disappears as a CONSEQUENCE, not as a separate step: the menu is built
  // from open tabs, so a project with none is no longer listed.
  //
  // Order matters when clearing the CURRENT scope. Navigating away first (while
  // its tabs still exist) keeps this URL-first (CLAUDE.md) — the destination is
  // resolved from live rows, then the loader re-scopes. Closing first would
  // strand the URL on a tab that no longer exists and leave the resolver nothing
  // to pick. Global is the honest landing: the project being emptied cannot be
  // the destination, and `dockForGlobalEntry` falls back to Home on its own.
  const handleCloseProject = async (bucket: TabProjectBucket) => {
    setClosingId(bucket.projectId);
    try {
      if (bucket.projectId === currentProjectId) {
        navigation.openDock(await dockForGlobalEntry(currentDock));
      }
      await bucket.closeAll();
    } catch (error) {
      notify.error({
        title: t`Couldn't close the project's tabs`,
        message: error instanceof Error ? error.message : String(error),
        id: `project-close-all:${bucket.projectId}`,
      });
    } finally {
      setClosingId(null);
    }
  };

  // Selecting the Global row re-focuses the Global scope (it's only shown while
  // Global is already current). URL-first: resolve the most-recently-active
  // global tab (or Home) and navigate; the loader re-scopes off the URL.
  const handleSelectGlobal = async () => {
    setOpen(false);
    navigation.openDock(await dockForGlobalEntry(currentDock));
  };

  // The list only switches between projects that already own tabs; opening
  // one that doesn't (or a brand-new folder) goes through the same
  // OpenProjectComponent dialog the footer's Switch Project button uses. The
  // dialog is rendered by the chip via {@link ProjectListOpenDialog}, outside
  // the popover, since Radix unmounts the popover content on close.
  const handleOpenProject = () => {
    setOpen(false);
    setProjectDialogOpen(true);
  };

  return {
    open,
    setOpen,
    currentProjectId,
    buckets,
    projectTotal,
    globalTabCount,
    isGlobalScope,
    projectName,
    scopeLabel,
    projectsLabel,
    tabsLabel,
    recoveringId,
    closingId,
    handleSelect,
    handleSelectGlobal,
    handleCloseProject,
    projectDialogOpen,
    setProjectDialogOpen,
    handleOpenProject,
  };
}

/**
 * The "Open project" dialog the list's bottom button pops. The chip renders
 * this once, as a sibling of its Popover (NOT inside the popover content,
 * which unmounts on close and would take the dialog with it).
 */
export function ProjectListOpenDialog({ menu }: { menu: ProjectListMenu }) {
  const { refetch: refetchProjects } = useProjects();
  return (
    <OpenProjectComponent
      open={menu.projectDialogOpen}
      onOpenChange={menu.setProjectDialogOpen}
      onProjectChanged={() => void refetchProjects()}
    />
  );
}

/** The full-width "Open project" button that closes the project list. */
function OpenProjectRow({ menu }: { menu: ProjectListMenu }) {
  return (
    <button
      type="button"
      onClick={menu.handleOpenProject}
      className="flex w-full items-center justify-center gap-2 rounded border border-border px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      data-testid="projects-counter-open-project"
    >
      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
      <Trans>Open project</Trans>
    </button>
  );
}

/** The two counts, one line each — the body of the chip's hover surface, so
 *  which number is which is unmistakable. The caller names the scope above it. */
export function ProjectCountsSummary({ menu }: { menu: ProjectListMenu }) {
  return (
    <>
      <span className="text-muted-foreground">{menu.projectsLabel}</span>
      <span className="text-muted-foreground">{menu.tabsLabel}</span>
    </>
  );
}

/**
 * The open-projects count as the chip wears it on its trigger: hairline,
 * project glyph, number, toned for the nav bar's runtime tint. Renders nothing
 * at zero — a "0" advertises nothing.
 */
export function ProjectCountBadge({ menu }: { menu: ProjectListMenu }) {
  if (menu.projectTotal === 0) return null;
  const ProjectIcon = iconForType(Project.type);
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums"
      data-testid="project-count-badge"
      aria-label={menu.projectsLabel}
    >
      <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-white/40" />
      <ProjectIcon className="h-3 w-3 shrink-0 opacity-80" />
      {menu.projectTotal}
    </span>
  );
}

/**
 * The list itself — the `<ul>` that goes inside a `PopoverContent`. The caller
 * owns the Popover and its content so the chip keeps its own testid, width
 * and alignment. With nothing to list it says so, rather than opening onto an
 * empty box.
 */
export function ProjectListPopoverContent({ menu }: { menu: ProjectListMenu }) {
  const {
    buckets,
    currentProjectId,
    isGlobalScope,
    globalTabCount,
    recoveringId,
    closingId,
    handleSelect,
    handleSelectGlobal,
    handleCloseProject,
  } = menu;
  const { t } = useLingui();
  const openProjectRow = (
    <div className="mt-1 border-t border-border pt-1">
      <OpenProjectRow menu={menu} />
    </div>
  );

  // Buckets in parent → subproject render order (a subproject is a project
  // whose folder lives inside another open project's folder). Display-only
  // nesting; see buildProjectTreeRows. Built here, not in the hook, so a closed
  // chip never pays for it — Radix mounts this content only while open.
  const treeRows = useMemo(() => buildProjectTreeRows(buckets), [buckets]);

  // Per-type icon from the backend TypeInfo registry (CLAUDE.md: never hardcode
  // a glyph for an entity type) — the same project icon every other surface shows.
  // Global is a pseudo-scope (not an entity type), so it uses a plain `Globe` glyph.
  const ProjectIcon = iconForType(Project.type);

  if (!isGlobalScope && treeRows.length === 0) {
    return (
      <div>
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          <Trans>No project has open tabs yet.</Trans>
        </div>
        {openProjectRow}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col">
        {isGlobalScope ? (
          // The Global scope row — violet-accented so it never reads as a
          // regular project, and always the current scope when shown.
          <li key="__global__">
            <button
              type="button"
              aria-current="true"
              onClick={() => void handleSelectGlobal()}
              className="flex w-full items-center gap-2 rounded bg-violet-500/10 px-2 py-1.5 text-start text-sm font-medium hover:bg-violet-500/15"
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
        {isGlobalScope && treeRows.length > 0 ? (
          // Small mid-title separating the Global row from the project
          // buckets below it.
          <li key="__projects_title__" aria-hidden>
            <SectionHairlineTitle>
              <Trans>Active projects</Trans>
            </SectionHairlineTitle>
          </li>
        ) : null}
        {treeRows.map(({ bucket, guides }) => {
          const isCurrent = bucket.projectId === currentProjectId;
          const isRecovering = recoveringId === bucket.projectId;
          const isMissing = bucket.state === 'missing';
          // Live/loading rows lead with the per-type PROJECT icon from the
          // TypeInfo registry (never a hardcoded glyph); a missing row
          // swaps in its recover affordance instead.
          let leadingIcon: React.ReactNode = (
            <ProjectIcon className={`h-3.5 w-3.5 shrink-0 ${isCurrent ? 'text-primary' : 'text-muted-foreground'}`} />
          );
          if (isMissing) {
            leadingIcon = isRecovering ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5 shrink-0" />
            );
          }
          const isClosing = closingId === bucket.projectId;
          // The close control is a SIBLING of the select button, not a child:
          // a button inside a button is invalid HTML, and browsers recover from
          // it by dropping the inner one — the row would swallow every close.
          // The `<li>` is the flex row; `group` lets the X reveal on row hover.
          const rowClass = `group flex w-full items-center gap-2 rounded pe-1 hover:bg-muted ${
            isCurrent ? 'bg-muted/60' : ''
          }`;
          const selectClass = `flex min-w-0 flex-1 items-center gap-2 rounded py-1.5 ps-2 text-left text-sm ${
            isCurrent ? 'font-medium' : ''
          } ${isMissing ? 'text-muted-foreground' : ''}`;
          return (
            <li key={bucket.projectId} className={rowClass}>
              <button
                type="button"
                aria-current={isCurrent ? 'true' : undefined}
                disabled={bucket.state === 'loading' || isRecovering || isClosing}
                onClick={() => void handleSelect(bucket)}
                className={selectClass}
              >
                <RowGuides guides={guides} />
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
              {/* Close-all-in-this-project. Emptying the bucket is what removes
                  the row: the menu is built from open tabs, so a project with
                  none simply stops being listed. Reachable on a MISSING row too
                  — that is the only exit for an orphan whose project can never
                  be recovered. Kept mounted (not hover-gated in the DOM) so it
                  stays keyboard-reachable and testable; only opacity changes. */}
              <button
                type="button"
                disabled={isClosing || isRecovering}
                onClick={() => void handleCloseProject(bucket)}
                title={t`Close all ${bucket.tabCount} tabs in this project`}
                aria-label={t`Close all ${bucket.tabCount} tabs in this project`}
                data-testid={`projects-counter-close-${bucket.projectId}`}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
              >
                {isClosing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {openProjectRow}
    </div>
  );
}
