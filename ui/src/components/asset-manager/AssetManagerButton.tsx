import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ActionInfo, AgenticProcess, dataManager, GitWorkdir, type AssetDescriptor } from '@sdk';
import { Boxes, GitCommitHorizontal, Loader2, WandSparkles } from 'lucide-react';
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
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { invalidateGitStatus } from '@src/lib/git-status-cache';
import { animateMinimizeToProcessChip } from '@src/lib/minimize-to-element';
import { notify } from '@src/notifications';
import type { WorkerType as TranscriptWorkerType } from '@src/hooks/use-transcript';
import {
  launchAssetAnalysis,
  launchAssetCorrect,
  waitForAssetAnalysisResult,
} from '@src/components/assets/editor/skill/skill-eval-analysis';
import {
  descriptorKey,
  dirname,
  displayLabelForTypeid as _displayLabelForTypeid,
  improvableMainFile,
  normalizePath,
  parseTypeid as _parseTypeid,
} from './asset-row-helpers';
import { useProcessAssets } from './useProcessAssets';
import { useLaunchingAgent } from '@src/hooks/use-launching-agent';
import { AssetManagerPopover } from './AssetManagerPopover';

function normalizeTranscriptWorker(workerType: string | null | undefined): TranscriptWorkerType {
  const w = (workerType ?? 'claude').toLowerCase();
  if (w.includes('codex')) return 'codex';
  if (w.includes('copilot')) return 'copilot';
  if (w.includes('workflow')) return 'workflow';
  return 'claude';
}

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

interface AssetManagerButtonProps {
  /** The process whose assets are managed. Null before first-send. */
  process: AgenticProcess | null;
  /** Optional element used as the trigger; defaults to a small icon button. */
  trigger?: React.ReactNode;
}

/**
 * "Assets for this process" button — the process HOST for
 * `AssetManagerPopover`.
 *
 * The popover itself is presentational. This component owns everything that
 * touches an `AgenticProcess`: reading its asset list, subscribing to its
 * entity-field changes, mounting/unmounting the Flowpad Assistant, adding and
 * removing `--add-dir` folders, and running the asset improvement flow. Each of
 * those is handed down as a *status prop* plus an *event*, so the popover can be
 * reused by surfaces that have no process at all.
 *
 * Deliberately NOT a picker: it passes no `onPick`/`onUnpick`, so the list is a
 * read-only board of what this run used vs what is available to it. Picking an
 * asset is a different question from browsing what the process can see, and
 * conflating them made every name click mutate `embedded_asset_refs` (and flip
 * `restart_required`) as a side effect of looking around.
 */
export function AssetManagerButton({ process, trigger }: AssetManagerButtonProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
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
    useCallback((cb) => (process ? dataManager.subscribe(process.typeId, cb, false) : () => {}), [process]),
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
    return dataManager.getByTypeIdFromCache<AgenticProcess>(process.typeId) ?? process;
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
    void dataManager
      .refreshByTypeId(process.typeId)
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
        console.error('[AssetManagerButton] process hydration failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [open, process, processSnapshot]);

  const assets = useProcessAssets(activeProcess, { enabled: open });
  const launchingAgent = useLaunchingAgent(activeProcess?.deployment_id, { enabled: open });
  const { refresh } = assets;
  // Only the type registry is wanted; `withVaults` would fetch a payload we discard.
  const { types: assetTypes } = useAssetTypes({ withVaults: false });
  const transcriptSessionId = activeProcess?.session_id ?? hydratedTranscriptIdentity.sessionId;
  const transcriptWorkerType = normalizeTranscriptWorker(
    activeProcess?.worker_type ?? hydratedTranscriptIdentity.workerType,
  );

  const assetTypeByName = useMemo(() => {
    void assetTypes;
    return new Map(dataManager.getAllTypeInfos().map((ti) => [ti.type_name, ti]));
  }, [assetTypes]);

  const canImprove = useCallback(
    (descriptor: AssetDescriptor) => !!improvableMainFile(descriptor, assetTypeByName),
    [assetTypeByName],
  );

  const additionalDirs = useMemo(() => activeProcess?.additional_dirs ?? [], [activeProcess?.additional_dirs]);

  // Resolved Flowpad Assistant mount status for this process. `null`/`undefined`
  // inherits the global default (currently ON), so only an explicit `false`
  // reads as disabled. Toggling writes an explicit boolean. Stays `undefined`
  // with no process, which is what hides the toggle entirely.
  const assistantEnabled = activeProcess ? activeProcess.load_flowpad_assistant !== false : undefined;

  const handleToggleAssistant = useCallback(async () => {
    if (!activeProcess) return;
    try {
      await activeProcess.setAssistantEnabled(activeProcess.load_flowpad_assistant === false);
      await refresh();
    } catch (err) {
      console.error('[AssetManagerButton] toggle Flowpad Assistant failed', err);
    }
  }, [activeProcess, refresh]);

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

  const handleAddFolder = useCallback(async () => {
    if (!activeProcess) return;
    const cn = dataCtx.computeNode;
    if (!cn) return;
    const picked = await cn.openPathDialog();
    if (!picked) return;
    await activeProcess.addDir(picked);
    await refresh();
  }, [activeProcess, dataCtx.computeNode, refresh]);

  const handleAddProjectDir = useCallback(
    async (path: string) => {
      if (!activeProcess || !path) return;
      await activeProcess.addDir(path);
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
        notify.error({
          title: t`Cannot improve asset`,
          message: t`This folder-backed asset has no main file metadata.`,
        });
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

  const commitAsset = useCallback(
    async (target: AssetImproveTarget) => {
      const action = new ActionInfo('commit-asset', 'compute_node', target.computeNodeId, 'POST');
      action.bodyParameters = { workdir: target.workdir, file: target.file };
      const result = await dataManager.callAction<null, { committed: boolean; version?: number }>(action);
      invalidateGitStatus(target.computeNodeId, target.workdir);
      if (result?.committed) {
        notify.success({ title: `Saved ${target.assetLabel} v${result.version ?? ''}`.trim() });
      } else {
        notify.info({ title: t`Nothing to save`, message: t`The asset matches HEAD.` });
      }
    },
    [t],
  );

  const runImprovement = useCallback(
    async (target: AssetImproveTarget, issueRequest: string, opts: { skipDirtyCheck?: boolean } = {}) => {
      if (!activeProcess?.session_id) {
        notify.error({ title: t`Cannot improve asset`, message: t`This process has no transcript session yet.` });
        return;
      }
      const notificationId = `asset-improve:${target.assetKey}`;
      try {
        if (!opts.skipDirtyCheck && (await assetHasDirtyChanges(target))) {
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
        navigation.openDock(
          DockPointer.forAssetCompare({
            computeNodeId: target.computeNodeId,
            workdir: target.workdir,
            file: target.file,
            assetPath: target.assetPath,
            assetType: target.assetType,
            assetLabel: target.assetLabel,
          }),
        );
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

  const triggerNode = trigger ?? (
    <button
      type="button"
      title={t`Manage assets`}
      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      data-testid="asset-manager-button"
    >
      <Boxes className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <>
      <AssetManagerPopover
        trigger={triggerNode}
        open={open}
        onOpenChange={setOpen}
        assets={assets}
        agent={launchingAgent}
        assistantEnabled={assistantEnabled}
        additionalDirs={additionalDirs}
        improveBusyKey={busyAssetKey}
        canImprove={canImprove}
        onToggleAssistant={activeProcess ? handleToggleAssistant : undefined}
        onAddFolder={activeProcess && dataCtx.computeNode ? handleAddFolder : undefined}
        onRemoveDir={activeProcess ? handleRemoveDir : undefined}
        onAddProjectDir={activeProcess ? handleAddProjectDir : undefined}
        // The wand is offered only once a transcript session exists — until then
        // improvement has nothing to run against.
        onImprove={transcriptSessionId ? openImproveDialog : undefined}
      />

      <Dialog
        open={!!fixDescriptor}
        onOpenChange={(next) => {
          if (!next) setFixDescriptor(null);
        }}
      >
        <DialogContent ref={improveDialogRef} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <Trans>What would you like to fix?</Trans>
            </DialogTitle>
            <DialogDescription>{fixDescriptor ? _displayLabelForTypeid(fixDescriptor.typeid) : null}</DialogDescription>
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
            <Button
              onClick={() => {
                void submitImproveDialog();
              }}
              disabled={!fixText.trim() || !!busyAssetKey}
            >
              {busyAssetKey ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <WandSparkles className="h-3.5 w-3.5" />
              )}
              <Trans>Analyze and improve</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!dirtyImprove}
        onOpenChange={(next) => {
          if (!next) setDirtyImprove(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              <Trans>Asset has changes</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Save the current asset changes as a version before running improvement.</Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDirtyImprove(null)} disabled={!!busyAssetKey}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              onClick={() => {
                void saveDirtyAndContinue();
              }}
              disabled={!!busyAssetKey}
            >
              {busyAssetKey ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitCommitHorizontal className="h-3.5 w-3.5" />
              )}
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
