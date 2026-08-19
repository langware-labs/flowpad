import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  assetDescriptorHasUsage,
  dataContext,
  dataManager,
  FLOWPAD_ASSISTANT_PROJECT_NAME,
  FLOWPAD_ASSISTANT_PROJECT_UNAME,
  isReadOnlySource,
  isTypeId,
  Project,
  QueryRequest,
  TypeId,
  VFSPath,
  type Agent,
  type AssetDescriptor,
} from '@sdk';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { AgentTypeChip } from '@src/components/agents/AgentIntroCard';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useProcessAssets, type UseProcessAssetsResult } from './useProcessAssets';
import { additionalDirScope, assetScope, AssetScopeChip, type AssetScope } from './asset-scope';
import { FusionSpinner } from '@src/components/icons/FusionSpinner';
import { WikiTip } from '@src/components/wiki-tip';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { EntityIcon, useEntityLocationLabel } from '@src/components/graph-view/ui/EntityIcon';
import {
  basename as _basename,
  descriptorKey,
  displayLabelForTypeid as _displayLabelForTypeid,
  isOpenableTypeid as _isOpenableTypeid,
  parseTypeid as _parseTypeid,
} from './asset-row-helpers';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

import { cn } from '@src/lib/utils';
import {
  ArrowLeft,
  ArrowDownAZ,
  Boxes,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Plus,
  Search,
  Sparkles,
  SquareArrowOutUpRight,
  WandSparkles,
  X,
} from 'lucide-react';

/** The wiki page behind the improve wand's tip. */
const ASSET_IMPROVEMENT_WIKI = 'Asset improvement';

/**
 * One column template, applied identically to every row (asset rows and dir
 * rows alike) so cells line up down the list:
 *
 *   name chip │ scope icon │ scope name │ explorer │ wand │ select
 *
 * Deliberately not CSS subgrid: a row carries its own background (selected rows
 * are tinted) and bottom border, which `display: contents` would throw away.
 * Fixed tracks on a fixed-width popover align by construction, and cost nothing.
 *
 * The corollary is that optional cells still have to occupy their track — see
 * `GridCellSpacer`. Rows whose wand or un-select button is absent were the whole
 * reason nothing lined up before.
 */
const ASSET_GRID_ROW =
  'grid grid-cols-[minmax(0,1fr)_1.25rem_4.5rem_1.5rem_1.5rem_1.5rem] items-center gap-2 px-3 py-1.5';

/** Holds a grid track open where an optional cell isn't rendered. */
function GridCellSpacer() {
  return <span aria-hidden />;
}

/**
 * Section divider — a centered, tinted label ruled out to both edges. Marks the
 * usage axis (used vs available), the coarsest split in the list.
 */
function AssetSectionRule({ testid, children }: { testid: string; children: React.ReactNode }) {
  return (
    <div
      className="sticky top-0 z-[1] flex items-center gap-2 border-b bg-popover/95 px-3 py-1.5 backdrop-blur"
      data-testid={testid}
    >
      <span className="h-px flex-1 bg-primary/30" aria-hidden />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">{children}</span>
      <span className="h-px flex-1 bg-primary/30" aria-hidden />
    </div>
  );
}

/** Sub-category header inside a section — the asset type ("Skills", "Agents"). */
function AssetTypeHeader({ testid, children }: { testid: string; children: React.ReactNode }) {
  return (
    <div
      className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-primary/70"
      data-testid={testid}
    >
      {children}
    </div>
  );
}

export interface AssetManagerPopoverProps {
  /** The popover trigger; passed to PopoverTrigger asChild. Ignored when `centered`. */
  trigger?: React.ReactNode;
  /** Controlled open state. Omit to let the popover manage its own. */
  open?: boolean;
  /** Required alongside `open`. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Preferred side to open on. Defaults to `'bottom'`. Pass `'top'` when the
   * trigger sits near the bottom of the viewport (e.g. a message composer) so
   * the list opens upward. Collision detection still flips it back if there's
   * no room. Ignored when `centered`.
   */
  side?: 'top' | 'bottom';
  /**
   * Render as a centered modal dialog instead of a popover anchored to the
   * trigger. Use when the trigger is incidental (a fan-out menu item) or when
   * the surface must escape an enclosing menu.
   */
  centered?: boolean;
  /** Placeholder for the filter box. */
  searchPlaceholder?: string;

  /**
   * Host-owned asset list. Omit and the popover fetches the project-wide
   * staging list itself. Process-backed hosts pass their own
   * `useProcessAssets(process, …)` so EMBEDDED / ADDITIONAL_DIR / usage state
   * is present.
   */
  assets?: UseProcessAssetsResult;
  /**
   * The Agent this process was launched through (`useLaunchingAgent`). Pinned
   * at the top of the list as the run's principal — avatar + name, click opens
   * the agent. Absent for a process not spawned from an Agent.
   */
  agent?: Agent | null;
  /** Restrict the visible candidates. Default: everything the source returned. */
  filter?: (descriptor: AssetDescriptor) => boolean;

  // ── selection: status in, actions out ──────────────────────────────────
  /**
   * Already-chosen assets, keyed by TYPEID. Keying by typeid rather than
   * (typeid, source) is deliberate: attaching a `user_dir` asset makes a second
   * `embedded` row appear, and both must read as selected.
   */
  selectedTypeIds?: readonly string[];
  /**
   * A row was chosen. Receives the whole descriptor — hosts that only want the
   * ref read `d.typeid`, while pick surfaces need `posix_path`/`source`.
   *
   * Optional: omitting it makes the surface a READ-ONLY board — no select
   * control renders at all, and the two sections read purely as "what this run
   * used" vs "what is available". That is what the process asset manager wants;
   * pick surfaces (composer attach, favorites, automation rail) supply it.
   */
  onPick?: (descriptor: AssetDescriptor) => void | Promise<void>;
  /**
   * A selected row was un-chosen. Absent ⇒ this is a one-shot surface: no
   * un-select control, and the list closes after a pick. Supplying it is what
   * makes the surface multi-select, so the two can't fall out of step.
   */
  onUnpick?: (descriptor: AssetDescriptor) => void | Promise<void>;

  // ── process-derived status (props) ─────────────────────────────────────
  /** Whether the Flowpad Assistant is mounted. Paints the toggle and the
   *  mounted-location marker; `onToggleAssistant` is what makes them render. */
  assistantEnabled?: boolean;
  /** Directories mounted into the process via `--add-dir`. */
  additionalDirs?: readonly string[];
  /** `descriptorKey()` of the asset whose improvement is currently running. */
  improveBusyKey?: string | null;
  /**
   * Whether an asset can actually be improved. Supplied by the host because it
   * owns the improve flow (and the type registry it consults) — deriving it
   * here too would let the wand appear on rows the host then refuses.
   */
  canImprove?: (descriptor: AssetDescriptor) => boolean;

  // ── actions (events) — each one also gates its own affordance ──────────
  onToggleAssistant?: () => void | Promise<void>;
  onAddFolder?: () => void | Promise<void>;
  onRemoveDir?: (path: string) => void | Promise<void>;
  onAddProjectDir?: (path: string) => void | Promise<void>;
  onImprove?: (descriptor: AssetDescriptor) => void;
}

/** Shared empty default — a stable identity, so optional array props don't
 *  invalidate the memos that depend on them on every render. */
const NONE: readonly string[] = [];

/**
 * Skills + agents only — the candidate set for "run something on this".
 * Workflows are deliberately excluded: they are runnable themselves rather than
 * embeddable into another process.
 */
export const RUNNABLE_ASSETS = (d: AssetDescriptor): boolean =>
  d.typeid.startsWith('skill-') || d.typeid.startsWith('subagent-');

/**
 * Reusable asset list popover.
 *
 * Purely presentational: it renders the descriptor list it is given and emits
 * events. Everything that reads or mutates an `AgenticProcess` lives in the
 * host (see `AssetManagerButton`), which passes the resulting status down as
 * props. An affordance renders iff the callback implementing it was supplied.
 *
 * Each row is a single ``(typeid, source)`` descriptor. The same typeid may
 * appear multiple times with different sources (e.g. a skill that's both
 * EMBEDDED and USER_DIR), and selection is keyed by typeid so every row for one
 * asset reads as selected together.
 */
export function AssetManagerPopover({
  trigger,
  open: controlledOpen,
  onOpenChange,
  side = 'bottom',
  centered = false,
  searchPlaceholder,
  assets,
  agent = null,
  filter,
  selectedTypeIds = NONE,
  onPick,
  onUnpick,
  assistantEnabled,
  additionalDirs = NONE,
  improveBusyKey = null,
  canImprove,
  onToggleAssistant,
  onAddFolder,
  onRemoveDir,
  onAddProjectDir,
  onImprove,
}: AssetManagerPopoverProps) {
  const { t } = useLingui();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (isControlled) onOpenChange?.(next);
      else setUncontrolledOpen(next);
    },
    [isControlled, onOpenChange],
  );
  const [view, setView] = useState<'list' | 'pick-project' | 'assistant'>('list');
  const [listFilter, setListFilter] = useState('');
  const [sortBy, setSortBy] = useState<'scope' | 'name'>('scope');

  // No host list supplied (a pick surface with no process): fetch the
  // project-wide staging list ourselves. `enabled` is false whenever the host
  // owns the data, so only one fetch is ever in flight.
  const ownAssets = useProcessAssets(null, { enabled: open && !assets });

  // ── Flowpad Assistant drill-down ────────────────────────────────────────
  // The assistant's assets are mounted wholesale via `--add-dir`, so they never
  // appear as individual rows in the main list — one location row stands in for
  // the lot. Clicking it descends INTO that project: the same `get-assets`
  // action, asked of `@flowpad_assistant` instead of the current subject, so
  // the rows are the same shape and render through the same grid.
  const browsingAssistant = view === 'assistant';
  const assistantAssets = useProcessAssets(null, {
    enabled: open && browsingAssistant,
    projectId: `@${FLOWPAD_ASSISTANT_PROJECT_UNAME}`,
  });
  // The assistant's OWN assets: the action's scan-dir policy always folds in the
  // user home, and those rows belong to the user, not to the assistant. Read
  // through the scope model rather than the raw source string, so a backend
  // source rename degrades the chip instead of silently emptying this list.
  const assistantDescriptors = useMemo(
    () => assistantAssets.descriptors.filter((d) => assetScope(d).kind === 'project'),
    [assistantAssets.descriptors],
  );

  // What the body lists. A drill-down is a foreign, READ-ONLY board: its own
  // source and loading flag, one section, no host filter, no dirs, no select or
  // improve. Decided once here so the rest of the render reads a value instead
  // of re-asking "are we in the drill-down?" at every row and section.
  const { descriptors: listDescriptors, isLoading: listIsLoading } = browsingAssistant
    ? { descriptors: assistantDescriptors, isLoading: assistantAssets.isLoading }
    : (assets ?? ownAssets);

  // Project picker — load once when entering pick-project mode.
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: allProjects = [] } = useEntitiesQuery<Project>(projectsQuery, {
    enabled: open && view === 'pick-project',
  });
  const [projectQuery, setProjectQuery] = useState('');

  /** Leave a drill-down / picker, dropping the filter that belonged to it. */
  const backToList = useCallback(() => {
    setView('list');
    setListFilter('');
    setProjectQuery('');
  }, []);

  /** Descend into the Flowpad Assistant's own assets. Same list, new subject. */
  const openAssistant = useCallback(() => {
    setListFilter('');
    setView('assistant');
  }, []);

  const handlePickProject = useCallback(
    async (path: string) => {
      if (!onAddProjectDir || !path) return;
      await onAddProjectDir(path);
      setView('list');
      setProjectQuery('');
    },
    [onAddProjectDir],
  );

  // Pre-fetch every descriptor's entity into the dataManager cache so the
  // chip text resolves to ``entity.displayName`` (typeid → real name) on
  // first render. ``getByTypeIdFromCache`` is sync and returns null for
  // entities not yet loaded; fetching them populates the cache and bumps
  // ``entityVersion`` to trigger a re-render that picks up the resolved
  // display labels. Without this, freshly-discovered entities show their
  // raw ``<type>-<uuid>`` typeid until something else loads them.
  const [entityVersion, setEntityVersion] = useState(0);
  useEffect(() => {
    if (!listDescriptors.length) return;
    const missing = listDescriptors
      .filter((d) => isTypeId(d.typeid))
      .map((d) => new TypeId(d.typeid))
      .filter((t) => !dataManager.getByTypeIdFromCache(t));
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(missing.map((t) => dataManager.getByTypeId(t).catch(() => null))).then(() => {
      if (!cancelled) setEntityVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [listDescriptors]);

  // The list has two nested axes, and they are different questions:
  //   section — is this asset already in play (selected, or used by the run)?
  //   group   — WHAT is it (skill / agent / …)?
  // The scope chip answers the third (where does it live), per row. One row per
  // (typeid, source) pair, so an asset visible through two sources stays visible
  // twice — that duplication is the point.
  //
  // ``entityVersion`` participates in the deps so newly-loaded entities trigger a
  // fresh build (display labels resolve from the cache).
  const sections = useMemo(() => {
    void entityVersion;

    // Resolve each descriptor's scope + label ONCE. Both are cache lookups that
    // allocate (a tooltip string, a display label), and a comparator would
    // otherwise re-derive them O(n log n) times — ~20k times for a 1000-asset
    // staging list, on every keystroke in the filter box.
    const selected = new Set(selectedTypeIds);
    // The host's `filter` scopes what it will accept a pick of; the assistant
    // drill-down picks nothing, so it shows the project whole.
    const candidates = filter && !browsingAssistant ? listDescriptors.filter(filter) : listDescriptors;
    const rows = candidates.map((d) => ({
      d,
      type: _parseTypeid(d.typeid).type,
      scope: assetScope(d),
      label: _displayLabelForTypeid(d.typeid),
      used: assetDescriptorHasUsage(d),
      selected: selected.has(d.typeid),
      improvable: !!canImprove?.(d),
      key: descriptorKey(d),
    }));
    type Row = (typeof rows)[number];

    const q = listFilter.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) =>
          [r.label, r.d.typeid, r.d.source, r.scope.label, r.d.posix_path, r.d.source_dir].some(
            (v) => typeof v === 'string' && v.toLowerCase().includes(q),
          ),
        )
      : rows;

    const byRow = (a: Row, b: Row) => {
      if (sortBy === 'scope' && a.scope.label !== b.scope.label) {
        return a.scope.label.localeCompare(b.scope.label);
      }
      if (a.label !== b.label) return a.label.localeCompare(b.label);
      return a.d.source.localeCompare(b.d.source);
    };

    const groupByType = (subset: Row[]) => {
      const buckets = new Map<string, Row[]>();
      for (const r of subset) {
        const bucket = buckets.get(r.type);
        if (bucket) bucket.push(r);
        else buckets.set(r.type, [r]);
      }
      return (
        [...buckets.entries()]
          // labelForType, not the useAssetTypes array: that one is view-mode
          // filtered and can miss a type Vibe mode still has descriptors for.
          .map(([type, rows]) => ({ type, label: labelForType(type), rows: rows.sort(byRow) }))
          .sort((a, b) => a.label.localeCompare(b.label))
      );
    };

    // The drill-down has no usage axis of its own — nothing in another project
    // is "used by" or "selected for" this run — so it collapses to one section.
    if (browsingAssistant) {
      const groups = groupByType(filtered);
      return groups.length ? [{ key: 'available' as const, label: t`Assistant assets`, groups }] : [];
    }

    // "Used" is only meaningful where a run reported usage. With no process
    // behind the list the top section holds purely the user's picks, so it is
    // labelled for what it actually contains.
    const topLabel = rows.some((r) => r.used) ? t`Used assets` : t`Selected assets`;

    // A group only exists if something was pushed into it, so a surviving
    // section always has rows — `sections.length === 0` is the emptiness test.
    return [
      { key: 'used' as const, label: topLabel, groups: groupByType(filtered.filter((r) => r.selected || r.used)) },
      {
        key: 'available' as const,
        label: t`Available assets`,
        groups: groupByType(filtered.filter((r) => !r.selected && !r.used)),
      },
    ].filter((s) => s.groups.length > 0);
  }, [browsingAssistant, canImprove, entityVersion, filter, listDescriptors, listFilter, selectedTypeIds, sortBy, t]);

  // Pinned rows (the launching agent, the assistant marker) sit above the
  // sections and are not filterable — they hide while a filter is typed and in
  // the assistant drill-down.
  const showPinnedRows = !browsingAssistant && !listFilter.trim();

  const filteredDirs = useMemo(() => {
    const q = listFilter.trim().toLowerCase();
    if (!q) return additionalDirs;
    return additionalDirs.filter((p) => p.toLowerCase().includes(q));
  }, [additionalDirs, listFilter]);

  const filteredProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    const list = allProjects.filter((p) => {
      const path = (p as { fs_storage_mount_path?: string }).fs_storage_mount_path;
      return !!path; // hide projects without a mount path
    });
    if (!q) return list;
    return list.filter((p) => {
      const name = (p.displayName ?? '').toLowerCase();
      const path = ((p as { fs_storage_mount_path?: string }).fs_storage_mount_path ?? '').toLowerCase();
      return name.includes(q) || path.includes(q);
    });
  }, [allProjects, projectQuery]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        setView('list');
        setProjectQuery('');
        setListFilter('');
      }
    },
    [setOpen],
  );

  const handlePick = useCallback(
    async (descriptor: AssetDescriptor) => {
      if (!onPick) return;
      // A surface with no un-select is one-shot: close on pick. Settle our own
      // open state BEFORE emitting, because such a host routinely unmounts this
      // component from inside `onPick` (the automation rail swaps itself for a
      // drawer), and setting state afterwards would write to an unmounted tree.
      if (!onUnpick) handleOpenChange(false);
      await onPick(descriptor);
    },
    [handleOpenChange, onPick, onUnpick],
  );

  const body = (
    <>
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        {view !== 'list' && (
          <button
            type="button"
            className="-ms-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            onClick={backToList}
            title={t`Back`}
            data-testid="asset-manager-back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
        {/* Breadcrumb — the root crumb is itself the way back up, so the trail
            and the back button are the same navigation, written twice on
            purpose (one is discoverable, the other is where the eye already is). */}
        <span className="flex min-w-0 items-center gap-1 text-xs font-medium" data-testid="asset-manager-breadcrumb">
          {view === 'list' ? (
            <Trans>Assets</Trans>
          ) : (
            <>
              <button
                type="button"
                onClick={backToList}
                className="rounded text-muted-foreground hover:text-foreground hover:underline"
                data-testid="asset-manager-crumb-root"
              >
                <Trans>Assets</Trans>
              </button>
              <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">
                {view === 'pick-project' ? <Trans>Pick project folder</Trans> : FLOWPAD_ASSISTANT_PROJECT_NAME}
              </span>
            </>
          )}
        </span>
        {view === 'list' && (
          <div className="ms-auto flex items-center gap-1">
            {onToggleAssistant && (
              <button
                type="button"
                role="switch"
                aria-checked={assistantEnabled}
                onClick={() => {
                  void onToggleAssistant();
                }}
                title={
                  assistantEnabled
                    ? t`Flowpad Assistant is mounted (its skills & agents are passed to the worker via --add-dir). Click to unmount — a restart will be required.`
                    : t`Mount the Flowpad Assistant so its skills & agents become discoverable. Click to enable — a restart will be required.`
                }
                data-testid="asset-manager-assistant-toggle"
                data-enabled={assistantEnabled ? 'true' : 'false'}
                className={
                  'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-colors ' +
                  (assistantEnabled
                    ? 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/20'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')
                }
              >
                <Sparkles className="h-3 w-3" />
                <Trans>Assistant</Trans>
              </button>
            )}
            {/* Prop-gated: pick surfaces supply neither handler, so no
                  DropdownMenu mounts there at all — which is what keeps this
                  component safe to drop into a composer that forbids nested
                  popovers. */}
            {(onAddFolder || onAddProjectDir) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title={t`Add`}
                    className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    data-testid="asset-manager-add-menu"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {onAddFolder && (
                    <DropdownMenuItem
                      onSelect={() => {
                        void onAddFolder();
                      }}
                      data-testid="asset-manager-add-folder"
                    >
                      <FolderOpen className="me-2 h-3.5 w-3.5" />
                      <Trans>Folder…</Trans>
                    </DropdownMenuItem>
                  )}
                  {onAddProjectDir && (
                    <DropdownMenuItem
                      onSelect={() => {
                        setProjectQuery('');
                        setView('pick-project');
                      }}
                      data-testid="asset-manager-add-project-folder"
                    >
                      <FolderPlus className="me-2 h-3.5 w-3.5" />
                      <Trans>Project folder…</Trans>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {view !== 'pick-project' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5 border-b bg-muted/20 px-2 py-1.5">
            <Search className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            <input
              autoFocus
              type="text"
              placeholder={searchPlaceholder ?? t`Filter…`}
              value={listFilter}
              onChange={(e) => setListFilter(e.target.value)}
              className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
              data-testid="asset-manager-list-filter"
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'scope' | 'name')}
              className="rounded border bg-background px-1 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
              title={t`Sort within each type`}
              data-testid="asset-manager-list-sort"
            >
              <option value="scope">
                <Trans>By scope</Trans>
              </option>
              <option value="name">
                <Trans>By name</Trans>
              </option>
            </select>
            <ArrowDownAZ className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="asset-manager-list">
            {/* The run's principal — the Agent it was launched through. */}
            {showPinnedRows && agent && <LaunchingAgentRow agent={agent} />}
            {/* Flowpad Assistant location marker — its assets live inside the
                  installed package and are mounted via --add-dir, so they don't
                  show as individual rows. A light-bordered location row marks
                  where the flowpad assets come from when the toggle is on, and
                  descends into them on click. */}
            {showPinnedRows && assistantEnabled && (
              <button
                type="button"
                onClick={openAssistant}
                className="m-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-start hover:bg-primary/10"
                data-testid="asset-manager-flowpad-location"
                title={t`Flowpad Assistant — its skills & agents are mounted into this process via --add-dir. Click to browse them.`}
              >
                <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {FLOWPAD_ASSISTANT_PROJECT_NAME}
                </span>
                <span className="flex-shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                  <Trans>mounted</Trans>
                </span>
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden />
              </button>
            )}
            {!browsingAssistant &&
              filteredDirs.map((path) => <DirRow key={`dir|${path}`} path={path} onRemove={onRemoveDir} />)}
            {sections.length === 0 &&
              (browsingAssistant || filteredDirs.length === 0) &&
              (listIsLoading ? (
                <div
                  className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground"
                  data-testid="asset-manager-loading"
                >
                  <FusionSpinner size="xs" />
                  <span>
                    <Trans>Loading assets…</Trans>
                  </span>
                </div>
              ) : (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  {listFilter.trim() ? <Trans>No matches.</Trans> : <Trans>No assets available.</Trans>}
                </div>
              ))}
            {sections.map((section) => (
              <Fragment key={section.key}>
                <AssetSectionRule testid={`asset-manager-section-${section.key}`}>{section.label}</AssetSectionRule>
                {section.groups.map((group) => (
                  <Fragment key={group.type}>
                    <AssetTypeHeader testid={`asset-manager-group-${section.key}-${group.type}`}>
                      {group.label}
                    </AssetTypeHeader>
                    {group.rows.map((row) => (
                      <AssetRow
                        key={`${row.d.typeid}|${row.d.source}`}
                        descriptor={row.d}
                        scope={row.scope}
                        label={row.label}
                        selected={!browsingAssistant && row.selected}
                        improvable={row.improvable}
                        busy={improveBusyKey === row.key}
                        onPick={!browsingAssistant && onPick ? handlePick : undefined}
                        onUnpick={browsingAssistant ? undefined : onUnpick}
                        onImprove={browsingAssistant ? undefined : onImprove}
                      />
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-3 py-2">
            <input
              autoFocus
              type="text"
              placeholder={t`Search projects…`}
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
              className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
              data-testid="asset-manager-project-search"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filteredProjects.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                <Trans>No projects.</Trans>
              </div>
            )}
            {filteredProjects.map((p) => {
              const path = (p as { fs_storage_mount_path?: string }).fs_storage_mount_path ?? '';
              return (
                <ProjectPickRow key={p.id} name={p.displayName ?? p.id ?? ''} path={path} onPick={handlePickProject} />
              );
            })}
          </div>
        </div>
      )}
    </>
  );

  // Two containers, one body. `centered` escapes an enclosing menu (the
  // bookmarks tree, the composer's attach fan-out) where an anchored popover
  // would be trapped or immediately dismissed.
  if (centered) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="flex max-h-[min(85vh,40rem)] w-[30rem] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0"
          data-testid="asset-manager-popover"
        >
          <DialogTitle className="sr-only">
            <Trans>Assets</Trans>
          </DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        side={side}
        sideOffset={4}
        collisionPadding={8}
        className="flex max-h-[min(calc(100vh-6rem),var(--radix-popover-content-available-height))] w-[30rem] max-w-[calc(100vw-2rem)] flex-col p-0"
        data-testid="asset-manager-popover"
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}

// ── Row components ────────────────────────────────────────────────────────────

function DirRow({ path, onRemove }: { path: string; onRemove?: (path: string) => void | Promise<void> }) {
  const { t } = useLingui();
  return (
    <div className={cn(ASSET_GRID_ROW, 'border-b last:border-b-0')} data-testid={`asset-manager-dir-row-${path}`}>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground" title={path}>
        <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{_basename(path) || path}</span>
      </span>
      {/* Through the scope model like every other row: hand-rolling the chip here
          is how this dir ended up wearing the context-folder glyph while the
          assets inside it wore the additional-dir one. */}
      <AssetScopeChip scope={additionalDirScope(path)} testidSuffix={`dir-${path}`} />
      <GridCellSpacer />
      <GridCellSpacer />
      {onRemove ? (
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void onRemove(path)}
          title={t`Remove directory`}
          data-testid={`asset-manager-dir-remove-${path}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : (
        <GridCellSpacer />
      )}
    </div>
  );
}

function ProjectPickRow({
  name,
  path,
  onPick,
}: {
  name: string;
  path: string;
  onPick: (path: string) => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-start last:border-b-0 hover:bg-muted/50"
      onClick={() => void onPick(path)}
      data-testid={`asset-manager-project-pick-${path}`}
    >
      <FolderPlus className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground" title={name}>
          {name}
        </div>
        <div className="truncate text-[10px] text-muted-foreground" title={path}>
          {path}
        </div>
      </div>
    </button>
  );
}

/**
 * The run's principal, pinned above every asset section: the Agent this process
 * was launched through. Avatar (image / emoji / icon) with the name's initial
 * as the fallback, then the name; the row opens the agent.
 */
function LaunchingAgentRow({ agent }: { agent: Agent }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const name = agent.displayName;

  return (
    <button
      type="button"
      onClick={() => navigation.openDock(agent.dockPointer)}
      className="m-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded border border-border bg-muted/30 px-2.5 py-1.5 text-start hover:bg-muted"
      data-testid="asset-manager-launching-agent"
      title={t`Open ${name}`}
    >
      <AgentAvatar agent={agent} className="h-6 w-6 text-[11px]" data-testid="asset-manager-launching-agent-avatar" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" data-testid="asset-manager-launching-agent-name">
        {name}
      </span>
      <AgentTypeChip className="flex-shrink-0" />
    </button>
  );
}


export function AssetRow({
  descriptor,
  scope,
  label,
  selected,
  improvable,
  busy,
  onPick,
  onUnpick,
  onImprove,
}: {
  descriptor: AssetDescriptor;
  /** Resolved by the list memo — all of these are cache lookups or allocations,
   *  so they are derived once there rather than per render here. */
  scope: AssetScope;
  label: string;
  selected: boolean;
  improvable: boolean;
  busy: boolean;
  onPick?: (descriptor: AssetDescriptor) => void | Promise<void>;
  onUnpick?: (descriptor: AssetDescriptor) => void | Promise<void>;
  onImprove?: (descriptor: AssetDescriptor) => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { type, id } = _parseTypeid(descriptor.typeid);
  const readOnly = isReadOnlySource(descriptor.source);
  const openable = _isOpenableTypeid(descriptor.typeid);
  const locationText = useEntityLocationLabel(descriptor.remote);
  // The name chip OPENS the asset in its editor — clicking the thing you are
  // looking at should show you the thing. Selecting is a separate, explicit
  // control at the row end, and only exists where a host asked for it: on the
  // process asset manager this list is a read-only "used vs available" board.
  const togglesOff = selected && !!onUnpick;
  const pickLabel = togglesOff ? t`Remove ${label}` : t`Select ${label}`;
  const openActionLabel = !openable
    ? t`Inline persona — no backing entity`
    : readOnly
      ? t`View ${label} (read-only)`
      : t`Open ${label}`;
  const openActionTitle = locationText ? `${openActionLabel}\n${locationText}` : openActionLabel;
  const openActionAria = locationText ? `${openActionLabel}, ${locationText}` : openActionLabel;
  // Explorer targets the FILE, so an asset with no path (inline persona) has
  // nowhere to go — same "no backing file" story as a non-openable row.
  const explorerPath = descriptor.posix_path ?? null;
  const explorerLabel = explorerPath ? t`Show ${label} in Files` : t`Inline persona — no file on disk`;

  const onOpenExplorerClick = useCallback(() => {
    if (!explorerPath) return;
    try {
      // Read at CLICK time, not through `useContext`: that hook's snapshot spans
      // ~30 fields that churn on a live process, and this list mounts one row
      // per asset — subscribing per row would re-render the whole board on
      // every terminal tick for a value only this handler ever reads.
      const computeNode = dataContext.computeNode?.typeId ?? LOCAL_COMPUTE_NODE;
      navigation.openDock(DockPointer.forExplorer(VFSPath.fromMachinePath(explorerPath, computeNode).absVfsPath));
    } catch (err) {
      console.error('[AssetRow] failed to open asset in explorer', explorerPath, err);
    }
  }, [explorerPath, navigation]);

  const onOpenClick = useCallback(() => {
    if (!openable || !id) return;
    try {
      // Open by the asset's TypeId via the canonical DockPointer factory
      // (grammar editor/<editor>/typeid/<type>-<id>). Read-only sources open in
      // viewer mode (readOnly=1), passed as a real `?readOnly=1` query string
      // via the DockPointer options (not embedded in the path).
      navigation.openDock(
        DockPointer.forAssetEditorByTypeId(
          type,
          new TypeId(type, id),
          undefined,
          readOnly ? { readOnly: '1' } : undefined,
        ),
      );
    } catch (err) {
      console.error('[AssetRow] failed to open asset', descriptor.typeid, err);
    }
  }, [navigation, type, id, readOnly, openable, descriptor.typeid]);

  return (
    <div
      className={cn(ASSET_GRID_ROW, 'border-b last:border-b-0', selected && 'bg-primary/5')}
      data-testid={`asset-manager-row-${descriptor.typeid}-${descriptor.source}`}
      data-read-only={readOnly ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      data-scope={scope.kind}
    >
      <button
        type="button"
        onClick={onOpenClick}
        disabled={!openable}
        data-openable={openable ? 'true' : 'false'}
        className={cn(
          'flex min-w-0 items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs disabled:cursor-default disabled:opacity-60',
          selected
            ? 'border-primary/50 bg-primary/10 text-foreground hover:bg-primary/20'
            : 'border-border bg-muted/30 text-foreground hover:bg-muted',
        )}
        title={openActionTitle}
        aria-label={openActionAria}
        data-testid={`asset-manager-open-${descriptor.typeid}-${descriptor.source}`}
      >
        <EntityIcon
          type={type}
          remote={descriptor.remote}
          showLocationTooltip={false}
          density="compact"
          className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      <AssetScopeChip scope={scope} testidSuffix={`${descriptor.typeid}-${descriptor.source}`} />
      <button
        type="button"
        onClick={onOpenExplorerClick}
        disabled={!explorerPath}
        data-openable={explorerPath ? 'true' : 'false'}
        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title={explorerLabel}
        aria-label={explorerLabel}
        data-testid={`asset-manager-explorer-${descriptor.typeid}-${descriptor.source}`}
      >
        <SquareArrowOutUpRight className="h-3 w-3" />
      </button>
      {improvable && onImprove ? (
        <WikiTip
          wikiword={ASSET_IMPROVEMENT_WIKI}
          label={t`Analyze and improve`}
          buttonLabel={t`How does improving an asset work?`}
        >
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center rounded text-primary hover:bg-primary/10 disabled:opacity-60"
            onClick={() => onImprove(descriptor)}
            disabled={busy}
            aria-label={t`Analyze and improve`}
            data-testid={`asset-manager-improve-${descriptor.typeid}-${descriptor.source}`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <WandSparkles className="h-3 w-3" />}
          </button>
        </WikiTip>
      ) : (
        <GridCellSpacer />
      )}
      {/* The SELECT control. No read-only guard here: read-only describes whether
          the asset FILE can be edited, not whether the user's own selection can
          be undone. Most staged rows are read-only sources, so gating on it hid
          the control exactly where it is needed most.

          Absent entirely when the host supplied no selection callbacks — that is
          what turns this list into a read-only availability board. */}
      {togglesOff || onPick ? (
        <button
          type="button"
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded hover:bg-muted hover:text-foreground',
            togglesOff ? 'text-primary' : 'text-muted-foreground',
          )}
          onClick={() => {
            void (togglesOff ? onUnpick(descriptor) : onPick?.(descriptor));
          }}
          title={pickLabel}
          aria-label={pickLabel}
          aria-pressed={selected}
          data-testid={
            togglesOff
              ? `asset-manager-unselect-${descriptor.typeid}-${descriptor.source}`
              : `asset-manager-select-${descriptor.typeid}-${descriptor.source}`
          }
        >
          {togglesOff ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
        </button>
      ) : (
        <GridCellSpacer />
      )}
    </div>
  );
}
