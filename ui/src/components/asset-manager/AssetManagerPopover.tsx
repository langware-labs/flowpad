import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AgenticProcess,
  ASSET_SOURCE_LABEL,
  assetDescriptorHasUsage,
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
  type AssetSource,
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
import { useAssetTypes } from '@src/hooks/use-asset-types';
import {
  basename as _basename,
  displayLabelForTypeid as _displayLabelForTypeid,
  isOpenableTypeid as _isOpenableTypeid,
  makeIconForType,
  parseTypeid as _parseTypeid,
} from './asset-row-helpers';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { cn } from '@src/lib/utils';
import { invalidateGitStatus } from '@src/lib/git-status-cache';
import { notify } from '@src/notifications';
import type { WorkerType as TranscriptWorkerType } from '@src/hooks/use-transcript';
import {
  launchAssetAnalysis,
  launchAssetCorrect,
  waitForAssetAnalysisResult,
} from '@src/components/assets/editor/skill/skill-eval-analysis';
import { ArrowLeft, ArrowDownAZ, Boxes, Folder, FolderOpen, FolderPlus, GitCommitHorizontal, Loader2, Lock, Plus, Search, Sparkles, WandSparkles, X, type LucideIcon } from 'lucide-react';

const READONLY_TOOLTIP_BY_SOURCE: Partial<Record<AssetSource, string>> = {
  project_dir: 'Defined in the project — edits propagate to every process under this project. Attach to get a private editable copy.',
  user_dir: 'Defined in your user folder — edits propagate to every process you run. Attach to get a private editable copy.',
  workdir: 'Lives in the agent’s working directory. Attach to get a private editable copy.',
  additional_dir: 'Lives outside the project — edits propagate everywhere this path is referenced. Attach to get a private editable copy.',
};

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

function normalizePath(path: string | null | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function dirname(path: string): string {
  const n = normalizePath(path);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(0, idx) || '/' : '.';
}

function basename(path: string): string {
  const n = normalizePath(path);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(idx + 1) : n;
}

function descriptorKey(descriptor: AssetDescriptor): string {
  return `${descriptor.typeid}@${normalizePath(descriptor.posix_path)}`;
}

/** Sticky group header inside the asset list (Used / Available). */
function AssetSectionHeader({ testid, children }: { testid: string; children: React.ReactNode }) {
  return (
    <div
      className="sticky top-0 z-[1] border-b bg-muted/20 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground"
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
  const [sortBy, setSortBy] = useState<'source' | 'name'>('source');
  const [fixDescriptor, setFixDescriptor] = useState<AssetDescriptor | null>(null);
  const [fixText, setFixText] = useState('');
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

  const { descriptors, refresh } = useProcessAssets(activeProcess, { enabled: open });
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

  const iconForType = useMemo(() => makeIconForType(assetTypes), [assetTypes]);

  const attachedSet = useMemo(() => new Set(attachedRefs), [attachedRefs]);
  const assetTypeByName = useMemo(() => {
    void assetTypes;
    return new Map(dataManager.getAllTypeInfos().map((t) => [t.type_name, t]));
  }, [assetTypes]);

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
      // Used assets always float to the top — fast access to what the process
      // actually touched — regardless of the By-source / By-name selector, which
      // only orders within each group.
      const ua = assetDescriptorHasUsage(a);
      const ub = assetDescriptorHasUsage(b);
      if (ua !== ub) return ua ? -1 : 1;
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

  // Boundary between the used-first and available groups (-1 = all used).
  const firstAvailIdx = useMemo(
    () => rows.findIndex((r) => !assetDescriptorHasUsage(r)),
    [rows],
  );

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
      const file = folderBacked ? typeInfo?.main_file ?? '' : basename(assetPath);
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
                onChange={(e) => setSortBy(e.target.value as 'source' | 'name')}
                className="rounded border bg-background px-1 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
                title={t`Sort`}
                data-testid="asset-manager-list-sort"
              >
                <option value="source"><Trans>By source</Trans></option>
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
              {rows.length === 0 && filteredDirs.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  {listFilter.trim() ? <Trans>No matches.</Trans> : <Trans>No assets visible to this process.</Trans>}
                </div>
              )}
              {rows.map((d, idx) => {
                // rows are sorted used-first, so `firstAvailIdx` is the single
                // boundary between the "Used" and "Available" groups. Emit a
                // sticky header at the top of each non-empty group.
                const used = assetDescriptorHasUsage(d);
                return (
                  <Fragment key={`${d.typeid}|${d.source}|${idx}`}>
                    {idx === 0 && used && (
                      <AssetSectionHeader testid="asset-manager-section-used">
                        <Trans>Used assets</Trans>
                      </AssetSectionHeader>
                    )}
                    {idx === firstAvailIdx && (
                      <AssetSectionHeader testid="asset-manager-section-available">
                        <Trans>Available assets</Trans>
                      </AssetSectionHeader>
                    )}
                    <AssetRow
                      descriptor={d}
                      iconForType={iconForType}
                      attached={attachedSet.has(d.typeid)}
                      used={used}
                      busy={busyAssetKey === descriptorKey(d)}
                      onDetach={onDetach}
                      onImprove={openImproveDialog}
                    />
                  </Fragment>
                );
              })}
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
      <DialogContent className="sm:max-w-lg">
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
  iconForType: (type: string) => LucideIcon;
}

function AssetRow({
  descriptor,
  iconForType,
  attached,
  used,
  busy,
  onDetach,
  onImprove,
}: RowSharedProps & {
  attached: boolean;
  used: boolean;
  busy: boolean;
  onDetach: (ref: string) => void | Promise<void>;
  onImprove: (descriptor: AssetDescriptor) => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { type, id } = _parseTypeid(descriptor.typeid);
  const Icon = iconForType(type);
  const readOnly = isReadOnlySource(descriptor.source);
  const label = _displayLabelForTypeid(descriptor.typeid);
  const canImprove = used && !!normalizePath(descriptor.posix_path);
  const openable = _isOpenableTypeid(descriptor.typeid);

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

  const sourceLabel = ASSET_SOURCE_LABEL[descriptor.source];
  const sourceDirBasename = descriptor.source_dir ? _basename(descriptor.source_dir) : null;
  const sourcePillText = sourceDirBasename ? `${sourceLabel} · ${sourceDirBasename}` : sourceLabel;
  const sourceTooltip = [
    sourceLabel,
    descriptor.source_dir ? `from: ${descriptor.source_dir}` : null,
    descriptor.posix_path ?? t`(no file — inline persona)`,
  ].filter(Boolean).join('\n');
  const lockTooltip = READONLY_TOOLTIP_BY_SOURCE[descriptor.source] ?? t`Read-only from this process. Attach to get a private editable copy.`;

  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0',
        used && 'bg-primary/5',
      )}
      data-testid={`asset-manager-row-${descriptor.typeid}-${descriptor.source}`}
      data-read-only={readOnly ? 'true' : 'false'}
      data-used={used ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={onChipClick}
        disabled={!openable}
        data-openable={openable ? 'true' : 'false'}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-xs',
          openable
            ? 'bg-muted/30 text-foreground hover:bg-muted'
            : 'cursor-default border-dashed bg-muted/20 text-muted-foreground',
        )}
        title={
          !openable
            ? t`Inline persona — no backing entity`
            : readOnly
              ? t`View ${label} (read-only)`
              : t`Open ${label}`
        }
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {readOnly && (
        <Lock
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-label={t`Read-only`}
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
      {canImprove && (
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-primary hover:bg-primary/10 disabled:opacity-60"
          onClick={() => onImprove(descriptor)}
          disabled={busy}
          title={t`Analyze and improve`}
          data-testid={`asset-manager-improve-${descriptor.typeid}-${descriptor.source}`}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <WandSparkles className="h-3 w-3" />}
        </button>
      )}
      {attached && !readOnly && (
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void onDetach(descriptor.typeid)}
          title={t`Detach`}
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
  const { t } = useLingui();
  const { type } = _parseTypeid(descriptor.typeid);
  const Icon = iconForType(type);
  const readOnly = isReadOnlySource(descriptor.source);
  const lockTooltip = READONLY_TOOLTIP_BY_SOURCE[descriptor.source] ?? t`Read-only source. Attach to get a private editable copy.`;
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
          aria-label={t`Read-only source`}
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
