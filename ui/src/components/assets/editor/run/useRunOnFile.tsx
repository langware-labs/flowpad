import { useCallback, useState, type ReactNode } from 'react';
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
  /** Notified after a run starts so the host can flip to the Runs side tab. */
  onActiveSideTabChange?: (id: string) => void;
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
  onActiveSideTabChange,
}: UseRunOnFileArgs): UseRunOnFileResult {
  const { project } = useProject();

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

      void proc.prompt(instruction);
      setProcessEntry({ process: proc });
      onActiveSideTabChange?.('runs');
    },
    [targetVfsPath, filePath, project, onActiveSideTabChange],
  );

  const runWithAsset = useCallback(
    async (descriptor: AssetDescriptor) => {
      if (!targetVfsPath) {
        notify.error({
          title: 'Cannot run',
          message: 'This file has no backing entity yet.',
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
        notify.error({ title: 'Failed to start run' });
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
        notify.error({ title: 'Failed to enable MCP' });
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
          <AlertDialogTitle>Flow MCP not enabled</AlertDialogTitle>
          <AlertDialogDescription>
            The <code>flow-sdk-mcp</code> server is required to run with progress
            tracing. Enable it to continue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button disabled={mcpEnabling} onClick={() => void handleEnableMcp('project')}>
            Enable for project
          </Button>
          <Button disabled={mcpEnabling} onClick={() => void handleEnableMcp('user')}>
            Enable for user
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { runWithAsset, isStarting, processEntry, mcpModal };
}
