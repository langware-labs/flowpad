import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AgenticProcess,
  ASSET_SOURCE_LABEL,
  dataManager,
  FLOWPAD_ASSISTANT_PROJECT_NAME,
  isReadOnlySource,
  isTypeId,
  Project,
  QueryRequest,
  TypeId,
  type AssetDescriptor,
  type AssetSource,
} from '@sdk';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@src/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useProcessAssets } from './useProcessAssets';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import {
  basename as _basename,
  displayLabelForTypeid as _displayLabelForTypeid,
  makeIconForType,
  parseTypeid as _parseTypeid,
} from './asset-row-helpers';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ArrowLeft, ArrowDownAZ, Boxes, Folder, FolderOpen, FolderPlus, Lock, Plus, Search, Sparkles, X, type LucideIcon } from 'lucide-react';

const READONLY_TOOLTIP_BY_SOURCE: Partial<Record<AssetSource, string>> = {
  project_dir: 'Defined in the project — edits propagate to every process under this project. Attach to get a private editable copy.',
  user_dir: 'Defined in your user folder — edits propagate to every process you run. Attach to get a private editable copy.',
  workdir: 'Lives in the agent’s working directory. Attach to get a private editable copy.',
  additional_dir: 'Lives outside the project — edits propagate everywhere this path is referenced. Attach to get a private editable copy.',
};

interface AssetManagerPopoverProps {
  /** Process whose assets we are managing. Null before first-send. */
  process: AgenticProcess | null;
  /** Currently-attached refs (typeid strings). For pre-process staging. */
  attachedRefs: string[];
  onAttach: (ref: string) => void | Promise<void>;
  onDetach: (ref: string) => void | Promise<void>;
  /** The popover trigger; passed to PopoverTrigger asChild. */
  trigger: React.ReactNode;
  /** Optional extra content rendered below the assets table (e.g. project selector). */
  footer?: React.ReactNode;
}

/**
 * Reusable asset-management popover. Driven by `process.getAssets()`.
 *
 * Each row is a single ``(typeid, source)`` descriptor. The same typeid may
 * appear multiple times with different sources (e.g. a skill that's both
 * EMBEDDED and USER_DIR). The attach/detach toggle on a row writes to the
 * process's `embedded_asset_refs`; the EMBEDDED row appears after attach.
 */
export function AssetManagerPopover({
  process,
  attachedRefs,
  onAttach,
  onDetach,
  trigger,
  footer,
}: AssetManagerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'add' | 'pick-project'>('list');
  const [query, setQuery] = useState('');
  const [listFilter, setListFilter] = useState('');
  const [sortBy, setSortBy] = useState<'source' | 'name'>('source');

  const { descriptors, refresh } = useProcessAssets(process, { enabled: open });
  const { types: assetTypes } = useAssetTypes();

  const dataCtx = useDataContext();

  // Subscribe to entity-field changes (additional_dirs, restart_required,
  // load_flowpad_assistant, …) so the popover re-renders when the backend
  // mutates them in place. The snapshot folds in `load_flowpad_assistant` so
  // the header toggle + location marker re-render even when the process isn't
  // RUNNING (i.e. `restart_required` doesn't move).
  useSyncExternalStore(
    useCallback(
      (cb) => (process ? dataManager.subscribe(process.typeId, cb, false) : () => {}),
      [process],
    ),
    () => (process ? `${process.restart_required}|${process.load_flowpad_assistant}` : ''),
    () => (process ? `${process.restart_required}|${process.load_flowpad_assistant}` : ''),
  );

  const additionalDirs = process?.additional_dirs ?? [];

  // Resolved Flowpad Assistant mount status for this process. `null`/`undefined`
  // inherits the global default (currently ON), so only an explicit `false`
  // reads as disabled. Toggling writes an explicit boolean.
  const assistantEnabled = !!process && process.load_flowpad_assistant !== false;

  const handleToggleAssistant = useCallback(async () => {
    if (!process) return;
    try {
      await process.setAssistantEnabled(!assistantEnabled);
      await refresh();
    } catch (err) {
      console.error('[AssetManagerPopover] toggle Flowpad Assistant failed', err);
    }
  }, [process, assistantEnabled, refresh]);

  // When restart_required transitions from true → false (a successful restart
  // just completed) re-fetch descriptors so the list reflects the new worker
  // state — e.g. embedded assets that were materialized on start.
  const prevRestartRequired = useRef<boolean>(false);
  useEffect(() => {
    if (!process) return;
    const cur = !!process.restart_required;
    if (prevRestartRequired.current && !cur && open) {
      void refresh();
    }
    prevRestartRequired.current = cur;
  }, [process, process?.restart_required, open, refresh]);

  // Project picker — load once when entering pick-project mode.
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: allProjects = [] } = useEntitiesQuery<Project>(projectsQuery, {
    enabled: open && mode === 'pick-project',
  });
  const [projectQuery, setProjectQuery] = useState('');

  const handleAddFolder = useCallback(async () => {
    if (!process) return;
    const cn = dataCtx.computeNode;
    if (!cn) return;
    const picked = await cn.openPathDialog();
    if (!picked) return;
    await process.addDir(picked);
    await refresh();
  }, [process, dataCtx.computeNode, refresh]);

  const handlePickProject = useCallback(
    async (path: string) => {
      if (!process || !path) return;
      await process.addDir(path);
      setMode('list');
      setProjectQuery('');
      await refresh();
    },
    [process, refresh],
  );

  const handleRemoveDir = useCallback(
    async (path: string) => {
      if (!process) return;
      await process.removeDir(path);
      await refresh();
    },
    [process, refresh],
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
    if (!descriptors.length) return;
    const missing = descriptors
      .filter((d) => isTypeId(d.typeid))
      .map((d) => new TypeId(d.typeid))
      .filter((t) => !dataManager.getByTypeIdFromCache(t));
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(
      missing.map((t) => dataManager.getByTypeId(t).catch(() => null)),
    ).then(() => {
      if (!cancelled) setEntityVersion((v) => v + 1);
    });
    return () => { cancelled = true; };
  }, [descriptors]);

  const iconForType = useMemo(() => makeIconForType(assetTypes), [assetTypes]);

  const attachedSet = useMemo(() => new Set(attachedRefs), [attachedRefs]);

  // Group descriptors by typeid for the "list" mode — but show one row per
  // (typeid, source) pair so duplicate sources are explicitly visible.
  // ``entityVersion`` participates in the deps so newly-loaded entities
  // trigger a fresh build (the display label is resolved from the cache
  // inside the row component).
  const rows = useMemo(() => {
    void entityVersion;
    const q = listFilter.trim().toLowerCase();
    const filtered = q
      ? descriptors.filter((d) => {
          const label = _displayLabelForTypeid(d.typeid).toLowerCase();
          return (
            label.includes(q) ||
            d.typeid.toLowerCase().includes(q) ||
            d.source.toLowerCase().includes(q) ||
            (typeof d.posix_path === 'string' ? d.posix_path : '').toLowerCase().includes(q) ||
            (typeof d.source_dir === 'string' ? d.source_dir : '').toLowerCase().includes(q)
          );
        })
      : descriptors;
    return [...filtered].sort((a, b) => {
      if (sortBy === 'name') {
        const la = _displayLabelForTypeid(a.typeid).toLowerCase();
        const lb = _displayLabelForTypeid(b.typeid).toLowerCase();
        if (la !== lb) return la.localeCompare(lb);
        return a.source.localeCompare(b.source);
      }
      // Default: EMBEDDED first, then by source label, then by name suffix.
      const sa = a.source === 'embedded' ? 0 : 1;
      const sb = b.source === 'embedded' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.typeid.localeCompare(b.typeid);
    });
  }, [descriptors, entityVersion, listFilter, sortBy]);

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

  // Add-mode entries: anything not currently EMBEDDED. Each row is the
  // "source" copy that the user can attach to the process.
  const addModeRows = useMemo(() => {
    const embeddedTypeids = new Set(
      descriptors.filter((d) => d.source === 'embedded').map((d) => d.typeid),
    );
    const candidates = descriptors.filter(
      (d) => d.source !== 'embedded' && !embeddedTypeids.has(d.typeid),
    );
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((d) => d.typeid.toLowerCase().includes(q));
  }, [descriptors, query]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) void refresh();
      if (!next) {
        setMode('list');
        setQuery('');
        setProjectQuery('');
        setListFilter('');
      }
    },
    [refresh],
  );

  const toggleRow = useCallback(
    (ref: string) => {
      if (attachedSet.has(ref)) void onDetach(ref);
      else void onAttach(ref);
    },
    [attachedSet, onAttach, onDetach],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        collisionPadding={8}
        className="flex max-h-[min(calc(100vh-6rem),var(--radix-popover-content-available-height))] w-96 flex-col p-0"
        data-testid="asset-manager-popover"
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 border-b px-3 py-2">
          {mode !== 'list' && (
            <button
              type="button"
              className="-ml-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              onClick={() => setMode('list')}
              title="Back"
              data-testid="asset-manager-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">
            {mode === 'add'
              ? 'Add asset'
              : mode === 'pick-project'
              ? 'Pick project folder'
              : 'Assets'}
          </span>
          {mode === 'list' && (
            <div className="ml-auto flex items-center gap-1">
              {process && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={assistantEnabled}
                  onClick={() => void handleToggleAssistant()}
                  title={
                    assistantEnabled
                      ? 'Flowpad Assistant is mounted (its skills & agents are passed to the worker via --add-dir). Click to unmount — a restart will be required.'
                      : 'Mount the Flowpad Assistant so its skills & agents become discoverable. Click to enable — a restart will be required.'
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
                  Assistant
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title="Add"
                    className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    data-testid="asset-manager-add-menu"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    onSelect={() => setMode('add')}
                    data-testid="asset-manager-add-asset"
                  >
                    <Boxes className="mr-2 h-3.5 w-3.5" />
                    Asset…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!process || !dataCtx.computeNode}
                    onSelect={() => { void handleAddFolder(); }}
                    data-testid="asset-manager-add-folder"
                  >
                    <FolderOpen className="mr-2 h-3.5 w-3.5" />
                    Folder…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!process}
                    onSelect={() => { setProjectQuery(''); setMode('pick-project'); }}
                    data-testid="asset-manager-add-project-folder"
                  >
                    <FolderPlus className="mr-2 h-3.5 w-3.5" />
                    Project folder…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {mode === 'list' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1.5 border-b bg-muted/20 px-2 py-1.5">
              <Search className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
              <input
                type="text"
                placeholder="Filter…"
                value={listFilter}
                onChange={(e) => setListFilter(e.target.value)}
                className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
                data-testid="asset-manager-list-filter"
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'source' | 'name')}
                className="rounded border bg-background px-1 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
                title="Sort"
                data-testid="asset-manager-list-sort"
              >
                <option value="source">By source</option>
                <option value="name">By name</option>
              </select>
              <ArrowDownAZ className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="asset-manager-list">
              {/* Flowpad Assistant location marker — its assets live inside the
                  installed package and are mounted via --add-dir, so they don't
                  show as individual rows. A light-bordered location row marks
                  where the flowpad assets come from when the toggle is on. */}
              {assistantEnabled && !listFilter.trim() && (
                <div
                  className="m-1 flex items-center gap-2 rounded border border-primary/40 bg-primary/5 px-2.5 py-1.5"
                  data-testid="asset-manager-flowpad-location"
                  title="Flowpad Assistant — its skills & agents are mounted into this process via --add-dir."
                >
                  <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {FLOWPAD_ASSISTANT_PROJECT_NAME}
                  </span>
                  <span className="flex-shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                    mounted
                  </span>
                </div>
              )}
              {filteredDirs.map((path) => (
                <DirRow
                  key={`dir|${path}`}
                  path={path}
                  onRemove={handleRemoveDir}
                />
              ))}
              {rows.length === 0 && filteredDirs.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  {listFilter.trim() ? 'No matches.' : 'No assets visible to this process.'}
                </div>
              )}
              {rows.map((d, idx) => (
                <AssetRow
                  key={`${d.typeid}|${d.source}|${idx}`}
                  descriptor={d}
                  iconForType={iconForType}
                  attached={attachedSet.has(d.typeid)}
                  onDetach={onDetach}
                />
              ))}
            </div>

            {footer}
          </div>
        ) : mode === 'add' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b px-3 py-2">
              <input
                autoFocus
                type="text"
                placeholder="Search agents and skills…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                data-testid="asset-manager-search"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {addModeRows.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No matches.
                </div>
              )}
              {addModeRows.map((d, idx) => (
                <AddModeRow
                  key={`${d.typeid}|${d.source}|${idx}`}
                  descriptor={d}
                  iconForType={iconForType}
                  checked={attachedSet.has(d.typeid)}
                  onToggle={toggleRow}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b px-3 py-2">
              <input
                autoFocus
                type="text"
                placeholder="Search projects…"
                value={projectQuery}
                onChange={(e) => setProjectQuery(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                data-testid="asset-manager-project-search"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filteredProjects.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No projects.
                </div>
              )}
              {filteredProjects.map((p) => {
                const path = (p as { fs_storage_mount_path?: string }).fs_storage_mount_path ?? '';
                return (
                  <ProjectPickRow
                    key={p.id}
                    name={p.displayName ?? p.id ?? ''}
                    path={path}
                    onPick={handlePickProject}
                  />
                );
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Row components ────────────────────────────────────────────────────────────

function DirRow({
  path,
  onRemove,
}: {
  path: string;
  onRemove: (path: string) => void | Promise<void>;
}) {
  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
      data-testid={`asset-manager-dir-row-${path}`}
    >
      <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span
        className="min-w-0 flex-1 truncate text-xs text-foreground"
        title={path}
      >
        {_basename(path) || path}
      </span>
      <span
        className="flex-shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
        title={path}
      >
        {ASSET_SOURCE_LABEL.additional_dir}
      </span>
      <button
        type="button"
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => void onRemove(path)}
        title="Remove directory"
        data-testid={`asset-manager-dir-remove-${path}`}
      >
        <X className="h-3 w-3" />
      </button>
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
      className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left last:border-b-0 hover:bg-muted/50"
      onClick={() => void onPick(path)}
      data-testid={`asset-manager-project-pick-${path}`}
    >
      <FolderPlus className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground" title={name}>{name}</div>
        <div className="truncate text-[10px] text-muted-foreground" title={path}>{path}</div>
      </div>
    </button>
  );
}

interface RowSharedProps {
  descriptor: AssetDescriptor;
  iconForType: (type: string) => LucideIcon;
}

function AssetRow({
  descriptor,
  iconForType,
  attached,
  onDetach,
}: RowSharedProps & {
  attached: boolean;
  onDetach: (ref: string) => void | Promise<void>;
}) {
  const { navigation } = useDockNavigation();
  const { type, id } = _parseTypeid(descriptor.typeid);
  const Icon = iconForType(type);
  const readOnly = isReadOnlySource(descriptor.source);
  const label = _displayLabelForTypeid(descriptor.typeid);

  const onChipClick = useCallback(() => {
    if (!id) return;
    try {
      // Open by the asset's TypeId in the canonical grammar
      // (editor/<editor>/typeid/<type>-<id>). Read-only sources open in viewer
      // mode (readOnly=1), passed as a real `?readOnly=1` query string via the
      // DockPointer options (not embedded in the path).
      const editor = editorForType(type);
      if (!editor) return;
      navigation.openDock(
        AssetDocPointer.forTypeId(
          editor,
          new TypeId(type, id),
          readOnly ? { readOnly: '1' } : undefined,
        ).toDockPointer(),
      );
    } catch {
      // ignore navigation errors
    }
  }, [navigation, type, id, readOnly]);

  const sourceLabel = ASSET_SOURCE_LABEL[descriptor.source];
  const sourceDirBasename = descriptor.source_dir ? _basename(descriptor.source_dir) : null;
  const sourcePillText = sourceDirBasename ? `${sourceLabel} · ${sourceDirBasename}` : sourceLabel;
  const sourceTooltip = [
    sourceLabel,
    descriptor.source_dir ? `from: ${descriptor.source_dir}` : null,
    descriptor.posix_path ?? '(no file — inline persona)',
  ].filter(Boolean).join('\n');
  const lockTooltip = READONLY_TOOLTIP_BY_SOURCE[descriptor.source] ?? 'Read-only from this process. Attach to get a private editable copy.';

  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
      data-testid={`asset-manager-row-${descriptor.typeid}-${descriptor.source}`}
      data-read-only={readOnly ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={onChipClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-border bg-muted/30 px-1.5 py-0.5 text-xs text-foreground hover:bg-muted"
        title={readOnly ? `View ${label} (read-only)` : `Open ${label}`}
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {readOnly && (
        <Lock
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-label="Read-only"
          data-testid={`asset-manager-readonly-${descriptor.typeid}-${descriptor.source}`}
        >
          <title>{lockTooltip}</title>
        </Lock>
      )}
      <span
        className="max-w-[140px] flex-shrink-0 truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
        title={sourceTooltip}
        data-testid={`asset-manager-source-${descriptor.typeid}-${descriptor.source}`}
      >
        {sourcePillText}
      </span>
      {attached && !readOnly && (
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void onDetach(descriptor.typeid)}
          title="Detach"
          data-testid={`asset-manager-detach-${descriptor.typeid}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function AddModeRow({
  descriptor,
  iconForType,
  checked,
  onToggle,
}: RowSharedProps & {
  checked: boolean;
  onToggle: (ref: string) => void;
}) {
  const { type } = _parseTypeid(descriptor.typeid);
  const Icon = iconForType(type);
  const readOnly = isReadOnlySource(descriptor.source);
  const lockTooltip = READONLY_TOOLTIP_BY_SOURCE[descriptor.source] ?? 'Read-only source. Attach to get a private editable copy.';
  const label = _displayLabelForTypeid(descriptor.typeid);
  return (
    <label
      className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0 hover:bg-muted/50"
      data-testid={`asset-manager-add-row-${descriptor.typeid}`}
      data-read-only={readOnly ? 'true' : 'false'}
    >
      <input
        type="checkbox"
        className="h-3 w-3 flex-shrink-0"
        checked={checked}
        onChange={() => onToggle(descriptor.typeid)}
      />
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {readOnly && (
        <Lock
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-label="Read-only source"
          data-testid={`asset-manager-add-readonly-${descriptor.typeid}-${descriptor.source}`}
        >
          <title>{lockTooltip}</title>
        </Lock>
      )}
      <span
        className="flex-shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
        title={ASSET_SOURCE_LABEL[descriptor.source]}
      >
        {ASSET_SOURCE_LABEL[descriptor.source]}
      </span>
    </label>
  );
}
