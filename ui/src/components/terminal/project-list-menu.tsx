import { Trans, useLingui } from '@lingui/react/macro';
import { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { canonicalPath } from '@src/components/project-selector';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dockForGlobalEntry, dockForProjectEntry } from '@src/tabs/project-entry';
import { useTabProjectBuckets, type TabProjectBucket } from '@src/tabs/use-tab-manager';
import { cn } from '@src/lib/utils';
import { Globe, Loader2, RotateCcw } from 'lucide-react';
import React, { useMemo, useState } from 'react';

/**
 * THE project list — the "which open project am I in, and which can I switch
 * to" menu — as a headless hook plus the list it renders. Two chips wear it:
 * the advanced tab strip's {@link ProjectsCounterChip} and the navigation
 * bar's {@link RuntimeChip}. Each owns its own trigger, Popover and testids;
 * the buckets, ordering, counts and URL-first selection live here, once.
 */

function bucketDisplayName(bucket: TabProjectBucket): string {
  return bucket.project?.displayName ?? bucket.projectId;
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
   *  matching open bucket's name, so a project with live terminals still labels
   *  itself even without it. */
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
  summaryLabel: string;
  recoveringId: string | null;
  handleSelect: (bucket: TabProjectBucket) => Promise<void>;
  handleSelectGlobal: () => Promise<void>;
}

/** The project list's state and actions, trigger-agnostic. */
export function useProjectListMenu({
  currentProjectId = null,
  currentProjectName,
}: ProjectListMenuOptions): ProjectListMenu {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
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
  const countsLabel = `${projectsLabel}, ${tabsLabel}`;
  const summaryLabel = scopeLabel ? `${scopeLabel} — ${countsLabel}` : countsLabel;

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

  // Selecting the Global row re-focuses the Global scope (it's only shown while
  // Global is already current). URL-first: resolve the most-recently-active
  // global tab (or Home) and navigate; the loader re-scopes off the URL.
  const handleSelectGlobal = async () => {
    setOpen(false);
    navigation.openDock(await dockForGlobalEntry(currentDock));
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
    summaryLabel,
    recoveringId,
    handleSelect,
    handleSelectGlobal,
  };
}

/** The two counts, one line each — the body of both chips' hover surfaces, so
 *  which number is which is unmistakable. Each caller names the scope above
 *  it in its own way. */
export function ProjectCountsSummary({ menu }: { menu: ProjectListMenu }) {
  return (
    <>
      <span className="text-muted-foreground">{menu.projectsLabel}</span>
      <span className="text-muted-foreground">{menu.tabsLabel}</span>
    </>
  );
}

/**
 * The open-projects count as both chips wear it on their trigger: hairline,
 * project glyph, number. Renders nothing at zero — a "0" advertises nothing.
 * `hairlineClassName` / `iconClassName` carry the surface's tone (the strip's
 * chip sits on the page, the nav bar's on a runtime tint).
 */
export function ProjectCountBadge({
  menu,
  hairlineClassName = 'bg-border',
  iconClassName = 'text-muted-foreground',
}: {
  menu: ProjectListMenu;
  hairlineClassName?: string;
  iconClassName?: string;
}) {
  if (menu.projectTotal === 0) return null;
  const ProjectIcon = iconForType(Project.type);
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums"
      data-testid="project-count-badge"
      aria-label={menu.projectsLabel}
    >
      <span aria-hidden className={cn('mx-0.5 h-3 w-px shrink-0', hairlineClassName)} />
      <ProjectIcon className={cn('h-3 w-3 shrink-0', iconClassName)} />
      {menu.projectTotal}
    </span>
  );
}

/**
 * The list itself — the `<ul>` that goes inside a `PopoverContent`. The caller
 * owns the Popover and its content so each chip keeps its own testid, width
 * and alignment; this renders the rows the same way for both. With nothing to
 * list it says so, rather than opening onto an empty box.
 */
export function ProjectListPopoverContent({ menu }: { menu: ProjectListMenu }) {
  const { buckets, currentProjectId, isGlobalScope, globalTabCount, recoveringId, handleSelect, handleSelectGlobal } =
    menu;

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
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        <Trans>No project has open tabs yet.</Trans>
      </div>
    );
  }

  return (
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
          </li>
        );
      })}
    </ul>
  );
}
