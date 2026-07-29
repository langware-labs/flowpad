import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AgenticProcess,
  assetDescriptorHasUsage,
  assetSourceLabel,
  dataManager,
  FLOWPAD_ASSISTANT_PROJECT_NAME,
  isReadOnlySource,
  isTypeId,
  Project,
  QueryRequest,
  TypeId,
  ActionInfo,
  GitWorkdir,
  type AssetDescriptor,
} from '@sdk';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@src/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useProcessAssets } from './useProcessAssets';
import { additionalDirScope, assetScope, AssetScopeChip, type AssetScope } from './asset-scope';
import { FusionSpinner } from '@src/components/icons/FusionSpinner';
import { WikiTip } from '@src/components/wiki-tip';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import {
  EntityIcon,
  useEntityLocationLabel,
} from '@src/components/graph-view/ui/EntityIcon';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import {
  basename as _basename,
  displayLabelForTypeid as _displayLabelForTypeid,
  improvableMainFile,
  isOpenableTypeid as _isOpenableTypeid,
  normalizePath,
  parseTypeid as _parseTypeid,
} from './asset-row-helpers';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { cn } from '@src/lib/utils';
import { invalidateGitStatus } from '@src/lib/git-status-cache';
import { animateMinimizeToProcessChip } from '@src/lib/minimize-to-element';
import { notify } from '@src/notifications';
import type { WorkerType as TranscriptWorkerType } from '@src/hooks/use-transcript';
import {
  launchAssetAnalysis,
  launchAssetCorrect,
  waitForAssetAnalysisResult,
} from '@src/components/assets/editor/skill/skill-eval-analysis';
import { ArrowLeft, ArrowDownAZ, Boxes, Folder, FolderOpen, FolderPlus, GitCommitHorizontal, Loader2, Lock, Plus, Search, Sparkles, WandSparkles, X } from 'lucide-react';

/** The wiki page behind the improve wand's tip. */
const ASSET_IMPROVEMENT_WIKI = 'Asset improvement';

interface AssetImproveTarget {
  descriptor: AssetDescriptor;
  assetKey: string;
  assetTypeid: string;
  assetPath: string;
  assetLabel: string;
  assetType: string;
  workdir: string;
  file: string;
  folderBacked: boolean;
  computeNodeId: string;
}

function dirname(path: string): string {
  const n = normalizePath(path);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(0, idx) || '/' : '.';
}

function descriptorKey(descriptor: AssetDescriptor): string {
  return `${descriptor.typeid}@${normalizePath(descriptor.posix_path)}`;
}

/**
 * One column template, applied identically to every row (asset rows and dir
 * rows alike) so cells line up down the list:
 *
 *   name chip │ scope icon │ scope name │ wand │ detach
 *
 * Deliberately not CSS subgrid: a row carries its own background (used rows are
 * tinted) and bottom border, which `display: contents` would throw away. Fixed
 * tracks on a fixed-width popover align by construction, and cost nothing.
 *
 * The corollary is that optional cells still have to occupy their track — see
 * `GridCellSpacer`. Rows whose wand or detach button is absent were the whole
 * reason nothing lined up before.
 */
const ASSET_GRID_ROW = 'grid grid-cols-[minmax(0,1fr)_1.25rem_5.5rem_1.5rem_1.5rem] items-center gap-2 px-3 py-1.5';

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

function normalizeTranscriptWorker(workerType: string | null | undefined): TranscriptWorkerType {
  const w = (workerType ?? 'claude').toLowerCase();
  if (w.includes('codex')) return 'codex';
  if (w.includes('copilot')) return 'copilot';
  if (w.includes('workflow')) return 'workflow';
  return 'claude';
}

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
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'add' | 'pick-project'>('list');
  const [query, setQuery] = useState('');
  const [listFilter, setListFilter] = useState('');
  const [sortBy, setSortBy] = useState<'scope' | 'name'>('scope');
  const [fixDescriptor, setFixDescriptor] = useState<AssetDescriptor | null>(null);
  const [fixText, setFixText] = useState('');
  // The improve input dialog — on submit it genie-flies into the footer's
  // process chip (where the named "Improve <asset>" worker then appears), so the
  // run visibly moves to the footer instead of vanishing behind a toast.
  const improveDialogRef = useRef<HTMLDivElement | null>(null);
  const [busyAssetKey, setBusyAssetKey] = useState<string | null>(null);
  const [dirtyImprove, setDirtyImprove] = useState<{ target: AssetImproveTarget; issueRequest: string } | null>(null);
  const [processHydrationVersion, setProcessHydrationVersion] = useState(0);
  const [hydratedTranscriptIdentity, setHydratedTranscriptIdentity] = useState<{
    sessionId: string | null;
    workerType: string | null;
  }>({ sessionId: null, workerType: null });
  const hydratedProcessIds = useRef<Set<string>>(new Set());

  const dataCtx = useDataContext();
  const { navigation } = useDockNavigation();

  // Subscribe to entity-field changes (additional_dirs, restart_required,
  // load_flowpad_assistant, …) so the popover re-renders when the backend
  // mutates them in place. The snapshot folds in `load_flowpad_assistant` so
  // the header toggle + location marker re-render even when the process isn't
  // RUNNING (i.e. `restart_required` doesn't move).
  const processSnapshot = useSyncExternalStore(
    useCallback(
      (cb) => (process ? dataManager.subscribe(process.typeId, cb, false) : () => {}),
      [process],
    ),
    () => {
      if (!process) return '';
      const current = dataManager.getByTypeIdFromCache<AgenticProcess>(process.typeId) ?? process;
      return `${current.restart_required}|${current.load_flowpad_assistant}|${current.session_id ?? ''}|${current.worker_type ?? ''}`;
    },
    () => {
      if (!process) return '';
      const current = dataManager.getByTypeIdFromCache<AgenticProcess>(process.typeId) ?? process;
      return `${current.restart_required}|${current.load_flowpad_assistant}|${current.session_id ?? ''}|${current.worker_type ?? ''}`;
    },
  );

  const activeProcess = useMemo(() => {
    if (!process) return null;
    void processSnapshot;
    void processHydrationVersion;
    return dataManager.getByTypeIdFromCache(process.typeId) ?? process;
  }, [process, processHydrationVersion, processSnapshot]);

  const processKey = process?.typeId.toString() ?? '';

  useEffect(() => {
    setHydratedTranscriptIdentity({ sessionId: null, workerType: null });
  }, [processKey]);

  useEffect(() => {
    if (!open || !process) return;
    const current = dataManager.getByTypeIdFromCache<AgenticProcess>(process.typeId) ?? process;
    if (current.session_id) return;
    const processKey = process.typeId.toString();
    if (hydratedProcessIds.current.has(processKey)) return;
    hydratedProcessIds.current.add(processKey);
    let cancelled = false;
    void dataManager.refreshByTypeId(process.typeId)
      .then((fresh) => {
        if (cancelled) return;
        if (fresh instanceof AgenticProcess && fresh.session_id) {
          setHydratedTranscriptIdentity({
            sessionId: fresh.session_id,
            workerType: fresh.worker_type ?? null,
          });
        }
        setProcessHydrationVersion((version) => version + 1);
      })
      .catch((err) => {
        console.error('[AssetManagerPopover] process hydration failed', err);
      });
    return () => { cancelled = true; };
  }, [open, process, processSnapshot]);

  const { descriptors, isLoading, refresh } = useProcessAssets(activeProcess, { enabled: open });
  const { types: assetTypes } = useAssetTypes();
  const transcriptSessionId = activeProcess?.session_id ?? hydratedTranscriptIdentity.sessionId;
  const transcriptWorkerType = normalizeTranscriptWorker(
    activeProcess?.worker_type ?? hydratedTranscriptIdentity.workerType,
  );

  const additionalDirs = useMemo(() => activeProcess?.additional_dirs ?? [], [activeProcess?.additional_dirs]);

  // Resolved Flowpad Assistant mount status for this process. `null`/`undefined`
  // inherits the global default (currently ON), so only an explicit `false`
  // reads as disabled. Toggling writes an explicit boolean.
  const assistantEnabled = !!activeProcess && activeProcess.load_flowpad_assistant !== false;

  const handleToggleAssistant = useCallback(async () => {
    if (!activeProcess) return;
    try {
      await activeProcess.setAssistantEnabled(!assistantEnabled);
      await refresh();
    } catch (err) {
      console.error('[AssetManagerPopover] toggle Flowpad Assistant failed', err);
    }
  }, [activeProcess, assistantEnabled, refresh]);

  // When restart_required transitions from true → false (a successful restart
  // just completed) re-fetch descriptors so the list reflects the new worker
  // state — e.g. embedded assets that were materialized on start.
  const prevRestartRequired = useRef<boolean>(false);
  useEffect(() => {
    if (!activeProcess) return;
    const cur = !!activeProcess.restart_required;
    if (prevRestartRequired.current && !cur && open) {
      void refresh();
    }
    prevRestartRequired.current = cur;
  }, [activeProcess, activeProcess?.restart_required, open, refresh]);

  // Project picker — load once when entering pick-project mode.
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: allProjects = [] } = useEntitiesQuery<Project>(projectsQuery, {
    enabled: open && mode === 'pick-project',
  });
  const [projectQuery, setProjectQuery] = useState('');

  const handleAddFolder = useCallback(async () => {
    if (!activeProcess) return;
    const cn = dataCtx.computeNode;
    if (!cn) return;
    const picked = await cn.openPathDialog();
    if (!picked) return;
    await activeProcess.addDir(picked);
    await refresh();
  }, [activeProcess, dataCtx.computeNode, refresh]);

  const handlePickProject = useCallback(
    async (path: string) => {
      if (!activeProcess || !path) return;
      await activeProcess.addDir(path);
      setMode('list');
      setProjectQuery('');
      await refresh();
    },
    [activeProcess, refresh],
  );

  const handleRemoveDir = useCallback(
    async (path: string) => {
      if (!activeProcess) return;
      await activeProcess.removeDir(path);
      await refresh();
    },
    [activeProcess, refresh],
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

  const attachedSet = useMemo(() => new Set(attachedRefs), [attachedRefs]);
  const assetTypeByName = useMemo(() => {
    void assetTypes;
    return new Map(dataManager.getAllTypeInfos().map((t) => [t.type_name, t]));
  }, [assetTypes]);

  // The list has two nested axes, and they are different questions:
  //   section — did this run USE the asset (the usage[] axis)?
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
    const rows = descriptors.map((d) => ({
      d,
      type: _parseTypeid(d.typeid).type,
      scope: assetScope(d),
      label: _displayLabelForTypeid(d.typeid),
      used: assetDescriptorHasUsage(d),
    }));
    type Row = (typeof rows)[number];

    const q = listFilter.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) =>
          [r.label, r.d.typeid, r.d.source, r.scope.label, r.d.posix_path, r.d.source_dir]
            .some((v) => typeof v === 'string' && v.toLowerCase().includes(q)),
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
      return [...buckets.entries()]
        // labelForType, not the useAssetTypes array: that one is view-mode
        // filtered and can miss a type Vibe mode still has descriptors for.
        .map(([type, rows]) => ({ type, label: labelForType(type), rows: rows.sort(byRow) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    };

    // A group only exists if something was pushed into it, so a surviving
    // section always has rows — `sections.length === 0` is the emptiness test.
    return [
      { key: 'used' as const, groups: groupByType(filtered.filter((r) => r.used)) },
      { key: 'available' as const, groups: groupByType(filtered.filter((r) => !r.used)) },
    ].filter((s) => s.groups.length > 0);
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

  const resolveImproveTarget = useCallback(
    (descriptor: AssetDescriptor): AssetImproveTarget | null => {
      const assetPath = normalizePath(descriptor.posix_path);
      if (!assetPath) {
        notify.error({ title: t`Cannot improve asset`, message: t`This asset has no file path.` });
        return null;
      }
      const { type } = _parseTypeid(descriptor.typeid);
      const typeInfo = assetTypeByName.get(type);
      const folderBacked = !!typeInfo?.folder_backed;
      const file = improvableMainFile(descriptor, assetTypeByName);
      if (!file) {
        notify.error({ title: t`Cannot improve asset`, message: t`This folder-backed asset has no main file metadata.` });
        return null;
      }
      return {
        descriptor,
        assetKey: descriptorKey(descriptor),
        assetTypeid: descriptor.typeid,
        assetPath,
        assetLabel: _displayLabelForTypeid(descriptor.typeid),
        assetType: type,
        workdir: folderBacked ? assetPath : dirname(assetPath),
        file,
        folderBacked,
        computeNodeId: dataCtx.computeNode?.id ?? '@local',
      };
    },
    [assetTypeByName, dataCtx.computeNode?.id, t],
  );

  const assetHasDirtyChanges = useCallback(async (target: AssetImproveTarget): Promise<boolean> => {
    const diff = await new GitWorkdir(target.workdir, target.computeNodeId).assetDiff(target.file);
    return diff.files.length > 0;
  }, []);

  const commitAsset = useCallback(async (target: AssetImproveTarget) => {
    const action = new ActionInfo('commit-asset', 'compute_node', target.computeNodeId, 'POST');
    action.bodyParameters = { workdir: target.workdir, file: target.file };
    const result = await dataManager.callAction<null, { committed: boolean; version?: number }>(action);
    invalidateGitStatus(target.computeNodeId, target.workdir);
    if (result?.committed) {
      notify.success({ title: `Saved ${target.assetLabel} v${result.version ?? ''}`.trim() });
    } else {
      notify.info({ title: t`Nothing to save`, message: t`The asset matches HEAD.` });
    }
  }, [t]);

  const runImprovement = useCallback(
    async (target: AssetImproveTarget, issueRequest: string, opts: { skipDirtyCheck?: boolean } = {}) => {
      if (!activeProcess?.session_id) {
        notify.error({ title: t`Cannot improve asset`, message: t`This process has no transcript session yet.` });
        return;
      }
      const notificationId = `asset-improve:${target.assetKey}`;
      try {
        if (!opts.skipDirtyCheck && await assetHasDirtyChanges(target)) {
          setDirtyImprove({ target, issueRequest });
          return;
        }
        setBusyAssetKey(target.assetKey);
        const startedAt = Date.now();
        notify.busy({ id: notificationId, title: t`Analyzing asset`, message: target.assetLabel });
        const analysisProcess = await launchAssetAnalysis({
          assetKey: target.assetKey,
          assetTypeid: target.assetTypeid,
          assetPath: target.assetPath,
          assetLabel: target.assetLabel,
          issueRequest,
          sessionId: activeProcess.session_id,
          workerType: transcriptWorkerType,
        });
        if (!analysisProcess) return;
        await analysisProcess.waitForComplete();

        const analysis = await waitForAssetAnalysisResult({
          sessionId: activeProcess.session_id,
          assetKey: target.assetKey,
          assetTypeid: target.assetTypeid,
          assetPath: target.assetPath,
          sinceMs: startedAt,
        });
        if (!analysis?.findings.length) {
          notify.warning({
            id: notificationId,
            title: t`No findings found`,
            message: t`The analysis completed but did not produce asset-scoped findings.`,
          });
          return;
        }

        notify.busy({ id: notificationId, title: t`Improving asset`, message: target.assetLabel });
        const correctionProcess = await launchAssetCorrect({
          assetKey: target.assetKey,
          assetTypeid: target.assetTypeid,
          assetPath: target.assetPath,
          assetLabel: target.assetLabel,
          workdir: target.workdir,
          file: target.file,
          issueRequest,
          sessionId: activeProcess.session_id,
          findings: analysis.findings,
          analysisTrace: analysis.trace,
        });
        if (!correctionProcess) return;
        await correctionProcess.waitForComplete();

        invalidateGitStatus(target.computeNodeId, target.workdir);
        navigation.openDock(DockPointer.forAssetCompare({
          computeNodeId: target.computeNodeId,
          workdir: target.workdir,
          file: target.file,
          assetPath: target.assetPath,
          assetType: target.assetType,
          assetLabel: target.assetLabel,
        }));
        notify.success({ id: notificationId, title: t`Improvement ready`, message: t`Opened Asset compare.` });
        setOpen(false);
      } catch (err) {
        notify.error({
          id: notificationId,
          title: t`Improve failed`,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusyAssetKey(null);
      }
    },
    [activeProcess?.session_id, assetHasDirtyChanges, navigation, t, transcriptWorkerType],
  );

  const openImproveDialog = useCallback((descriptor: AssetDescriptor) => {
    setFixDescriptor(descriptor);
    setFixText('');
  }, []);

  const submitImproveDialog = useCallback(async () => {
    if (!fixDescriptor) return;
    const issueRequest = fixText.trim();
    if (!issueRequest) return;
    const target = resolveImproveTarget(fixDescriptor);
    if (!target) return;
    // Fly the dialog into the footer chip before it unmounts (the ghost is
    // cloned, so closing immediately is fine) — the run now lives there.
    animateMinimizeToProcessChip(improveDialogRef.current);
    setFixDescriptor(null);
    setFixText('');
    await runImprovement(target, issueRequest);
  }, [fixDescriptor, fixText, resolveImproveTarget, runImprovement]);

  const saveDirtyAndContinue = useCallback(async () => {
    const pending = dirtyImprove;
    if (!pending) return;
    setDirtyImprove(null);
    try {
      await commitAsset(pending.target);
      await runImprovement(pending.target, pending.issueRequest, { skipDirtyCheck: true });
    } catch (err) {
      notify.error({ title: t`Save failed`, message: err instanceof Error ? err.message : String(err) });
    }
  }, [commitAsset, dirtyImprove, runImprovement, t]);

  return (
    <>
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
              title={t`Back`}
              data-testid="asset-manager-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">
            {mode === 'add'
              ? <Trans>Add asset</Trans>
              : mode === 'pick-project'
              ? <Trans>Pick project folder</Trans>
              : <Trans>Assets</Trans>}
          </span>
          {mode === 'list' && (
            <div className="ml-auto flex items-center gap-1">
              {activeProcess && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={assistantEnabled}
                  onClick={() => void handleToggleAssistant()}
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
                  <DropdownMenuItem
                    onSelect={() => setMode('add')}
                    data-testid="asset-manager-add-asset"
                  >
                    <Boxes className="mr-2 h-3.5 w-3.5" />
                    <Trans>Asset…</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!activeProcess || !dataCtx.computeNode}
                    onSelect={() => { void handleAddFolder(); }}
                    data-testid="asset-manager-add-folder"
                  >
                    <FolderOpen className="mr-2 h-3.5 w-3.5" />
                    <Trans>Folder…</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!activeProcess}
                    onSelect={() => { setProjectQuery(''); setMode('pick-project'); }}
                    data-testid="asset-manager-add-project-folder"
                  >
                    <FolderPlus className="mr-2 h-3.5 w-3.5" />
                    <Trans>Project folder…</Trans>
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
                placeholder={t`Filter…`}
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
                <option value="scope"><Trans>By scope</Trans></option>
                <option value="name"><Trans>By name</Trans></option>
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
                  title={t`Flowpad Assistant — its skills & agents are mounted into this process via --add-dir.`}
                >
                  <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {FLOWPAD_ASSISTANT_PROJECT_NAME}
                  </span>
                  <span className="flex-shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                    <Trans>mounted</Trans>
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
              {sections.length === 0 && filteredDirs.length === 0 && (
                isLoading ? (
                  <div
                    className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground"
                    data-testid="asset-manager-loading"
                  >
                    <FusionSpinner size="xs" />
                    <span><Trans>Loading assets…</Trans></span>
                  </div>
                ) : (
                  <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                    {listFilter.trim() ? <Trans>No matches.</Trans> : <Trans>No assets visible to this process.</Trans>}
                  </div>
                )
              )}
              {sections.map((section) => (
                <Fragment key={section.key}>
                  <AssetSectionRule testid={`asset-manager-section-${section.key}`}>
                    {section.key === 'used' ? <Trans>Used assets</Trans> : <Trans>Available assets</Trans>}
                  </AssetSectionRule>
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
                          attached={attachedSet.has(row.d.typeid)}
                          used={row.used}
                          improvable={!!improvableMainFile(row.d, assetTypeByName)}
                          busy={busyAssetKey === descriptorKey(row.d)}
                          onDetach={onDetach}
                          onImprove={openImproveDialog}
                        />
                      ))}
                    </Fragment>
                  ))}
                </Fragment>
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
                placeholder={t`Search agents and skills…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                data-testid="asset-manager-search"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {addModeRows.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  <Trans>No matches.</Trans>
                </div>
              )}
              {addModeRows.map((d, idx) => (
                <AddModeRow
                  key={`${d.typeid}|${d.source}|${idx}`}
                  descriptor={d}
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

    <Dialog open={!!fixDescriptor} onOpenChange={(next) => { if (!next) setFixDescriptor(null); }}>
      <DialogContent ref={improveDialogRef} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle><Trans>What would you like to fix?</Trans></DialogTitle>
          <DialogDescription>
            {fixDescriptor ? _displayLabelForTypeid(fixDescriptor.typeid) : null}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={fixText}
          onChange={(event) => setFixText(event.target.value)}
          placeholder={t`Describe the issue to analyze and improve…`}
          className="min-h-28"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setFixDescriptor(null)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => { void submitImproveDialog(); }} disabled={!fixText.trim() || !!busyAssetKey}>
            {busyAssetKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
            <Trans>Analyze and improve</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={!!dirtyImprove} onOpenChange={(next) => { if (!next) setDirtyImprove(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle><Trans>Asset has changes</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Save the current asset changes as a version before running improvement.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDirtyImprove(null)} disabled={!!busyAssetKey}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => { void saveDirtyAndContinue(); }} disabled={!!busyAssetKey}>
            {busyAssetKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
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
  const { t } = useLingui();
  return (
    <div
      className={cn(ASSET_GRID_ROW, 'border-b last:border-b-0')}
      data-testid={`asset-manager-dir-row-${path}`}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground" title={path}>
        <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{_basename(path) || path}</span>
      </span>
      {/* Through the scope model like every other row: hand-rolling the chip here
          is how this dir ended up wearing the context-folder glyph while the
          assets inside it wore the additional-dir one. */}
      <AssetScopeChip scope={additionalDirScope(path)} testidSuffix={`dir-${path}`} />
      <GridCellSpacer />
      <button
        type="button"
        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => void onRemove(path)}
        title={t`Remove directory`}
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
}

export function AssetRow({
  descriptor,
  scope,
  label,
  attached,
  used,
  improvable,
  busy,
  onDetach,
  onImprove,
}: RowSharedProps & {
  /** Resolved by the list memo — both are cache lookups, so don't redo them here. */
  scope: AssetScope;
  label: string;
  attached: boolean;
  used: boolean;
  improvable: boolean;
  busy: boolean;
  onDetach: (ref: string) => void | Promise<void>;
  onImprove: (descriptor: AssetDescriptor) => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { type, id } = _parseTypeid(descriptor.typeid);
  const readOnly = isReadOnlySource(descriptor.source);
  // Only offer the wand when improvement can actually run — a used asset whose
  // main file resolves (see improvableMainFile). Gating on `used && posix_path`
  // alone showed the wand on folder-backed types with no resolvable main file
  // (e.g. a deck_template missing its main_file), which then errored on click.
  const canImprove = used && improvable;
  const openable = _isOpenableTypeid(descriptor.typeid);
  const locationText = useEntityLocationLabel(descriptor.remote);
  const openActionLabel =
    !openable
      ? t`Inline persona — no backing entity`
      : readOnly
        ? t`View ${label} (read-only)`
        : t`Open ${label}`;
  const openActionTitle = locationText
    ? `${openActionLabel}\n${locationText}`
    : openActionLabel;
  const openActionAria = locationText
    ? `${openActionLabel}, ${locationText}`
    : openActionLabel;

  const onChipClick = useCallback(() => {
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
      className={cn(ASSET_GRID_ROW, 'border-b last:border-b-0', used && 'bg-primary/5')}
      data-testid={`asset-manager-row-${descriptor.typeid}-${descriptor.source}`}
      data-read-only={readOnly ? 'true' : 'false'}
      data-used={used ? 'true' : 'false'}
      data-scope={scope.kind}
    >
      <button
        type="button"
        onClick={onChipClick}
        disabled={!openable}
        data-openable={openable ? 'true' : 'false'}
        className={cn(
          'flex min-w-0 items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-xs',
          openable
            ? 'bg-muted/30 text-foreground hover:bg-muted'
            : 'cursor-default border-dashed bg-muted/20 text-muted-foreground',
        )}
        title={openActionTitle}
        aria-label={openActionAria}
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
      {canImprove ? (
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
      {attached && !readOnly ? (
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void onDetach(descriptor.typeid)}
          title={t`Detach`}
          data-testid={`asset-manager-detach-${descriptor.typeid}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : (
        <GridCellSpacer />
      )}
    </div>
  );
}

export function AddModeRow({
  descriptor,
  checked,
  onToggle,
}: RowSharedProps & {
  checked: boolean;
  onToggle: (ref: string) => void;
}) {
  const { t } = useLingui();
  const { type } = _parseTypeid(descriptor.typeid);
  const readOnly = isReadOnlySource(descriptor.source);
  // Add mode keeps its lock + source pill; only the manage list moved to scope
  // chips. Take the tooltip from the scope model anyway, so the read-only copy
  // lives in exactly one place.
  const lockTooltip = assetScope(descriptor).tooltip;
  const label = _displayLabelForTypeid(descriptor.typeid);
  const locationText = useEntityLocationLabel(descriptor.remote);
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
      <EntityIcon
        type={type}
        remote={descriptor.remote}
        showLocationTooltip={false}
        density="compact"
        aria-hidden
        className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {locationText && <span className="sr-only">{locationText}</span>}
      {readOnly && (
        <Lock
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-label={t`Read-only source`}
          data-testid={`asset-manager-add-readonly-${descriptor.typeid}-${descriptor.source}`}
        >
          <title>{lockTooltip}</title>
        </Lock>
      )}
      <span
        className="flex-shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
        title={assetSourceLabel(descriptor.source)}
      >
        {assetSourceLabel(descriptor.source)}
      </span>
    </label>
  );
}
