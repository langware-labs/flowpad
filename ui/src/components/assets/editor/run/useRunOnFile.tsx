import { useCallback, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AgenticProcess,
  ComputeNode,
  ProcessKind,
  type AssetDescriptor,
} from '@sdk';
import { enableMcp, isMcpAvailable } from '@src/components/assets/utils';
import { Button } from '@src/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { notify } from '@src/notifications';
import { useProject } from '@src/hooks/useProject';
import { parseTypeid } from '@src/components/asset-manager/asset-row-helpers';
import type { ProcessEntry } from '@src/components/workflows-view/workflow-run-store';

interface UseRunOnFileArgs {
  /** VFS path the AgenticProcess will be keyed to (typically the file's TypeId or `<typeid>/<sub_path>`). */
  targetVfsPath: string | null;
  /** On-disk file path of the markdown file (used in the prompt text). */
  filePath: string | null;
  /** Called after a run starts so the host opens the Runs side window (`useSideWindows().open`). */
  onOpenSideWindow?: (id: string) => void;
}

interface UseRunOnFileResult {
  /** Spawn an AgenticProcess on the file with the picked asset attached. */
  runWithAsset: (descriptor: AssetDescriptor) => Promise<void>;
  isStarting: boolean;
  /** The most recent live run; rendered into the Runs side tab. */
  processEntry: ProcessEntry | null;
  /** Modal node — render in the editor tree to display the MCP-enable prompt. */
  mcpModal: ReactNode;
}

const MCP_SERVER = 'flow-sdk-mcp';

/**
 * Hook that owns the "Run an asset on this file" flow for the generic markdown
 * editor. Mirrors the lazy-create + attach + prompt pattern used by
 * `EntityExecutionPanel` (chat tab) and the spawn pattern used by
 * `WorkflowAssetEditor` (workflow runs):
 *
 *   1. Verify `flow-sdk-mcp` is enabled; if not, surface the modal.
 *   2. `ComputeNode.getById('@local').createProcess({ targetVfsPath, outputFormat: 'stream-json', … })`.
 *   3. `process.embeddedAssets.attach(descriptor.typeid)` — materialize the
 *      picked agent/skill so the CLI can load it via `--agents`.
 *   4. `process.prompt('run the file <path> with the asset <type>: <path>')`.
 *   5. Stash as the live `processEntry`; flip the side panel to the Runs tab.
 *
 * The hook owns the modal as a React subtree so the host only renders it.
 */
export function useRunOnFile({
  targetVfsPath,
  filePath,
  onOpenSideWindow,
}: UseRunOnFileArgs): UseRunOnFileResult {
  const { project } = useProject();
  const { t } = useLingui();

  const [isStarting, setIsStarting] = useState(false);
  const [processEntry, setProcessEntry] = useState<ProcessEntry | null>(null);
  const [pendingDescriptor, setPendingDescriptor] = useState<AssetDescriptor | null>(null);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [mcpEnabling, setMcpEnabling] = useState(false);

  const doRun = useCallback(
    async (descriptor: AssetDescriptor) => {
      if (!targetVfsPath) return;

      const computeNode = await ComputeNode.getById('@local');
      if (!computeNode) throw new Error('No local compute node');

      const proc: AgenticProcess = await computeNode.createProcess({
        workdir: project?.fs_storage_mount_path ?? undefined,
        projectId: project?.id,
        targetVfsPath,
        processType: ProcessKind.Execution,
        outputFormat: 'stream-json',
        permissionMode: 'bypassPermissions',
      });

      try {
        await proc.embeddedAssets.attach(descriptor.typeid);
      } catch (err) {
        console.error('[useRunOnFile] attach failed', descriptor.typeid, err);
      }

      const { type: assetType } = parseTypeid(descriptor.typeid);
      const assetLocator = descriptor.posix_path ?? descriptor.typeid;
      const fileLocator = filePath ?? targetVfsPath;
      const instruction = `Run the file ${fileLocator} with the asset ${assetType}: ${assetLocator}`;

      void proc.submit(instruction);
      setProcessEntry({ process: proc });
      onOpenSideWindow?.('runs');
    },
    [targetVfsPath, filePath, project, onOpenSideWindow],
  );

  const runWithAsset = useCallback(
    async (descriptor: AssetDescriptor) => {
      if (!targetVfsPath) {
        notify.error({
          title: t`Cannot run`,
          message: t`This file has no backing entity yet.`,
        });
        return;
      }
      setIsStarting(true);
      try {
        const available = await isMcpAvailable(MCP_SERVER);
        if (!available) {
          setPendingDescriptor(descriptor);
          setShowMcpModal(true);
          return;
        }
        await doRun(descriptor);
      } catch (err) {
        console.error('[useRunOnFile] run failed', err);
        notify.error({ title: t`Failed to start run` });
      } finally {
        setIsStarting(false);
      }
    },
    [targetVfsPath, doRun],
  );

  const handleEnableMcp = useCallback(
    async (scope: 'user' | 'project') => {
      if (!pendingDescriptor) {
        setShowMcpModal(false);
        return;
      }
      setMcpEnabling(true);
      try {
        await enableMcp(MCP_SERVER, scope);
        setShowMcpModal(false);
        notify.success({ title: `${MCP_SERVER} enabled (${scope} scope). Starting run…` });
        await doRun(pendingDescriptor);
      } catch (err) {
        console.error('[useRunOnFile] enable MCP failed', err);
        notify.error({ title: t`Failed to enable MCP` });
      } finally {
        setMcpEnabling(false);
        setPendingDescriptor(null);
      }
    },
    [pendingDescriptor, doRun],
  );

  const mcpModal = (
    <AlertDialog
      open={showMcpModal}
      onOpenChange={(next) => {
        setShowMcpModal(next);
        if (!next) setPendingDescriptor(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle><Trans>Flow MCP not enabled</Trans></AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>The <code>flow-sdk-mcp</code> server is required to run with progress tracing. Enable it to continue.</Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel><Trans>Cancel</Trans></AlertDialogCancel>
          <Button disabled={mcpEnabling} onClick={() => void handleEnableMcp('project')}>
            <Trans>Enable for project</Trans>
          </Button>
          <Button disabled={mcpEnabling} onClick={() => void handleEnableMcp('user')}>
            <Trans>Enable for user</Trans>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { runWithAsset, isStarting, processEntry, mcpModal };
}
