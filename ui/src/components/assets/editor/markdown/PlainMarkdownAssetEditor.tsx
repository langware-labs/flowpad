import { useCallback, useMemo, useState } from 'react';
import { MarkdownEditor } from './MarkdownEditor';
import { AssetPickerPopover } from '@src/components/asset-manager/AssetPickerPopover';
import { RunButton } from '@src/components/assets/editor/run/RunButton';
import { useRunOnFile } from '@src/components/assets/editor/run/useRunOnFile';
import { DiscussDocButtons } from '@src/components/assets/editor/discuss/DiscussDocButtons';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { WorkflowRunsPanel } from '@src/components/workflows-view/WorkflowRunsPanel';
import type { ProcessEntry } from '@src/components/workflows-view/workflow-run-store';
import { useProcessesForTarget } from '@src/components/entity-execution-panel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { dataContext, FrontMatterFsRef, ProcessKind } from '@sdk';
import type { APIEntity, FSRef } from '@sdk';
import { History } from 'lucide-react';

interface PlainMarkdownAssetEditorProps {
  /** FSRef to the .md file. */
  fsRef: FSRef;
  /** Entity type string (e.g. `"plan"`, `"claude_md"`, `"markdown"`). */
  assetType: string;
}

/**
 * Thin wrapper for markdown asset types that don't have a dedicated editor
 * (plan, claude_md, claude_memory, claude_rules, command, markdown).
 *
 * Resolves the backing entity by `asset_ref` so Chat + Backlinks tabs key
 * on the real TypeId (`"plan-<uuid>"`, …) instead of a path-based pseudo.
 *
 * Adds a Run button that opens an asset picker (skills + agents). On pick,
 * spawns an `AgenticProcess` with the asset attached and the file path
 * referenced in the prompt; the live run streams into a "Runs" side tab
 * (same panel used by the workflow editor).
 */
export function PlainMarkdownAssetEditor({ fsRef, assetType }: PlainMarkdownAssetEditorProps) {
  const { entity } = useEntityByPath<APIEntity<APIEntity<any>>>(assetType, fsRef);
  const chatTarget = entity ? entity.typeId.toString() : null;
  const assetRef = (entity as { asset_ref?: string } | null)?.asset_ref;
  const localTypeId = dataContext.computeNodeTypeId;
  // Memoize: useFSRefContent's load effect is keyed on fsRef identity, so a
  // fresh FrontMatterFsRef every render re-downloads the file on every re-render.
  const editorRef = useMemo(
    () => (assetRef && localTypeId ? new FrontMatterFsRef(assetRef, localTypeId) : fsRef),
    [assetRef, localTypeId, fsRef],
  );

  const { navigation } = useDockNavigation();
  // No backing FsRecord entity (raw CLAUDE.md etc.) → no delete button. The
  // tree row + the file remain; user can still delete via the filesystem tools.
  const deletable = entity as unknown as { delete?: () => Promise<boolean>; name?: string } | null;
  const onDelete = useCallback(async () => {
    if (!deletable?.delete) return;
    await deletable.delete();
    navigation.openDock(DockPointer.forAssetList(assetType));
  }, [deletable, navigation, assetType]);

  const [activeSideTab, setActiveSideTab] = useState<string>('editor');

  const { runWithAsset, isStarting, processEntry, mcpModal } = useRunOnFile({
    targetVfsPath: chatTarget,
    filePath: assetRef ?? fsRef.path,
    onActiveSideTabChange: setActiveSideTab,
  });

  const { processes: pastRunProcesses } = useProcessesForTarget(chatTarget ?? '', {
    enabled: !!chatTarget,
    processType: ProcessKind.Execution,
  });

  const runHistory = useMemo<ProcessEntry[]>(() => {
    const toMs = (d: unknown): number => {
      if (d instanceof Date) return d.getTime();
      if (typeof d === 'string') return new Date(d).getTime() || 0;
      return 0;
    };
    const sorted = [...pastRunProcesses].sort(
      (a, b) => toMs(b.created_date) - toMs(a.created_date),
    );
    const liveId = processEntry?.process.id;
    return sorted.map((p) => (liveId && p.id === liveId ? processEntry! : { process: p }));
  }, [pastRunProcesses, processEntry]);

  const isRunning = !!processEntry;

  const toolbar = (
    <>
      <DiscussDocButtons fsRef={fsRef} />
      <AssetPickerPopover
        trigger={
          <RunButton
            isRunning={isRunning}
            isStarting={isStarting}
            disabled={!chatTarget}
            title={!chatTarget ? 'No backing entity yet' : undefined}
          />
        }
        onPick={(d) => void runWithAsset(d)}
      />
    </>
  );

  const runsTab: ExtraSideTab = {
    id: 'runs',
    label: runHistory.length > 0 ? `Runs ${runHistory.length}` : 'Runs',
    icon: History,
    description: 'Runs on this file',
    panel: (
      <WorkflowRunsPanel
        entries={runHistory}
        currentEntry={processEntry}
        computeNodeId={fsRef.typeId.id}
      />
    ),
  };

  return (
    <>
      <MarkdownEditor
        fsRef={editorRef}
        chatTarget={chatTarget}
        toolbar={toolbar}
        extraSideTabs={[runsTab]}
        activeSideTab={activeSideTab}
        onActiveSideTabChange={setActiveSideTab}
        onDelete={deletable?.delete ? onDelete : undefined}
        deleteLabel={deletable?.name ?? undefined}
      />
      {mcpModal}
    </>
  );
}
