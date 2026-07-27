import { useCallback, useMemo } from 'react';
import { MarkdownEditor } from './MarkdownEditor';
import { AssetPickerPopover } from '@src/components/asset-manager/AssetPickerPopover';
import { RunButton } from '@src/components/assets/editor/run/RunButton';
import { useRunOnFile } from '@src/components/assets/editor/run/useRunOnFile';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { ProcessRunsPanel } from '@src/components/process-runs/ProcessRunsPanel';
import type { ProcessEntry } from '@src/components/process-runs/process-run-store';
import { useProcessesForTarget } from '@src/components/entity-execution-panel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useSideWindows } from '@src/navigation/useSideWindows';
import { DockPointer } from '@src/navigation/DockPointer';
import { dataContext, FrontMatterFsRef, ProcessKind } from '@sdk';
import type { APIEntity, FSRef } from '@sdk';
import { useDocTranslations } from '@src/components/assets/editor/translations/useDocTranslations';
import { History } from 'lucide-react';
import { AssetCollisionProvider } from '../AssetCollisionUI';

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
  // Body re-read token: the live entity's `updated_date` advances when a
  // reindex (agent turn-end / invalidate) re-parses the file, so a stable scalar
  // of it drives MarkdownEditor's out-of-band refresh. Guarded against unsaved edits.
  const baseReloadKey = entityReloadKey((entity as { updated_date?: unknown } | null)?.updated_date);
  const localTypeId = dataContext.computeNodeTypeId;

  // Memoize: useFSRefContent's load effect is keyed on fsRef identity, so a
  // fresh FrontMatterFsRef every render re-downloads the file on every re-render.
  const baseEditorRef = useMemo(
    () => (assetRef && localTypeId ? new FrontMatterFsRef(assetRef, localTypeId) : fsRef),
    [assetRef, localTypeId, fsRef],
  );

  // Document translation: the `?lang=` inline body swap, completion auto-refresh,
  // and the Translations side tab — shared with the wikitip modal surface.
  const { editorRef, reloadKey, translationsTab } = useDocTranslations({
    entity,
    chatTarget,
    assetRef,
    baseEditorRef,
    baseReloadKey,
  });

  const { navigation } = useDockNavigation();
  // No backing FsRecord entity (raw CLAUDE.md etc.) → no delete button. The
  // tree row + the file remain; user can still delete via the filesystem tools.
  const deletable = entity as unknown as { delete?: () => Promise<boolean>; name?: string } | null;
  const onDelete = useCallback(async () => {
    if (!deletable?.delete) return;
    await deletable.delete();
    navigation.openDock(DockPointer.forAssetList(assetType));
  }, [deletable, navigation, assetType]);

  const { open: openSideWindow } = useSideWindows();

  // Run is an advanced-only affordance; only fetch its run history when shown.
  const isAdvanced = useIsAdvanced();

  const { runWithAsset, isStarting, processEntry, mcpModal } = useRunOnFile({
    targetVfsPath: chatTarget,
    filePath: assetRef ?? fsRef.path,
    onOpenSideWindow: openSideWindow,
  });

  const { processes: pastRunProcesses } = useProcessesForTarget(chatTarget ?? '', {
    enabled: !!chatTarget && isAdvanced,
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

  const toolbar = isAdvanced ? (
    <AssetPickerPopover
      trigger={
        <RunButton
          iconOnly
          isRunning={isRunning}
          isStarting={isStarting}
          disabled={!chatTarget}
          title={!chatTarget ? 'No backing entity yet' : undefined}
        />
      }
      onPick={(d) => void runWithAsset(d)}
    />
  ) : undefined;

  const runsTab: ExtraSideTab = {
    id: 'runs',
    label: runHistory.length > 0 ? `Runs ${runHistory.length}` : 'Runs',
    icon: History,
    description: 'Runs on this file',
    panel: (
      <ProcessRunsPanel
        entries={runHistory}
        currentEntry={processEntry}
      />
    ),
  };

  return (
    <>
      <AssetCollisionProvider entity={entity}>
        <MarkdownEditor
          fsRef={editorRef}
          chatTarget={chatTarget}
          toolbar={toolbar}
          extraSideTabs={[translationsTab, runsTab]}
          onDelete={deletable?.delete ? onDelete : undefined}
          deleteLabel={deletable?.name ?? undefined}
          reloadKey={reloadKey}
        />
      </AssetCollisionProvider>
      {mcpModal}
    </>
  );
}
