import { useCallback, useMemo, useState } from 'react';
import { MarkdownEditor, type WikiLinkTarget } from './MarkdownEditor';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { ProcessRunsPanel } from '@src/components/process-runs/ProcessRunsPanel';
import type { ProcessEntry } from '@src/components/process-runs/process-run-store';
import { useProcessesForTarget } from '@src/components/entity-execution-panel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { toMs } from '@src/utils/process-recency';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useSideWindows } from '@src/navigation/useSideWindows';
import { DockPointer } from '@src/navigation/DockPointer';
import { dataContext, FrontMatterFsRef, ProcessKind } from '@sdk';
import type { APIEntity, FSRef, TypeId } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import { useDocTranslations } from '@src/components/assets/editor/translations/useDocTranslations';
import { History } from 'lucide-react';
import { AssetCollisionProvider } from '../AssetCollisionUI';

interface PlainMarkdownAssetEditorProps {
  /** FSRef to the .md file. */
  fsRef: FSRef;
  /** Entity type string (e.g. `"plan"`, `"claude_md"`, `"markdown"`). */
  assetType: string;
  /** Entity already resolved by a TypeId route; skips local path discovery. */
  resolvedEntity?: APIEntity<APIEntity<any>>;
  /** Optional wiki heading slug. */
  fragment?: string;
  /** Wiki page/namespace to retain for links when this asset is Wiki-rendered. */
  wikiLinkTarget?: WikiLinkTarget;
}

/**
 * Thin wrapper for markdown asset types that don't have a dedicated editor
 * (plan, claude_md, claude_memory, claude_rules, command, markdown).
 *
 * Resolves the backing entity by `asset_ref` so Chat + Backlinks tabs key
 * on the real TypeId (`"plan-<uuid>"`, …) instead of a path-based pseudo.
 *
 * Runs launched on this file elsewhere — e.g. translation workers from the
 * Translations side tab — show up in a "Runs" side tab (same panel used by
 * the workflow editor).
 */
export function PlainMarkdownAssetEditor({
  fsRef,
  assetType,
  resolvedEntity,
  fragment,
  wikiLinkTarget,
}: PlainMarkdownAssetEditorProps) {
  const { entity: pathEntity } = useEntityByPath<APIEntity<APIEntity<any>>>(
    resolvedEntity ? null : assetType,
    resolvedEntity ? null : fsRef,
  );
  const entity = resolvedEntity ?? pathEntity;
  const chatTarget = entity ? entity.typeId.toString() : null;
  const assetRef = (entity as { asset_ref?: string } | null)?.asset_ref;
  const [externalRevision, setExternalRevision] = useState(0);
  const subscribedTypes = useMemo(() => [assetType], [assetType]);
  const onEntityOp = useCallback(
    (typeId: TypeId, op: 'create' | 'update' | 'delete') => {
      if ((op === 'create' || op === 'update') && typeId.toString() === chatTarget) {
        setExternalRevision((revision) => revision + 1);
      }
    },
    [chatTarget],
  );
  useEntityOps(subscribedTypes, onEntityOp);

  // Body re-read token: the live entity's `updated_date` advances when a
  // reindex (agent turn-end / invalidate) re-parses the file, so a stable scalar
  // of it drives MarkdownEditor's out-of-band refresh. The explicit entity-op
  // revision also covers SDK entities updated in place, where React Query can
  // preserve object identity and therefore skip a render. MarkdownEditor guards
  // both paths against replacing unsaved edits.
  const baseReloadKey = `${entityReloadKey((entity as { updated_date?: unknown } | null)?.updated_date)}:${externalRevision}`;
  const localTypeId = dataContext.computeNodeTypeId;

  // Memoize: useFSRefContent's load effect is keyed on fsRef identity, so a
  // fresh FrontMatterFsRef every render re-downloads the file on every re-render.
  const baseEditorRef = useMemo(
    () => (!resolvedEntity && assetRef && localTypeId ? new FrontMatterFsRef(assetRef, localTypeId) : fsRef),
    [resolvedEntity, assetRef, localTypeId, fsRef],
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

  // Run history is an advanced-only affordance, and its panel isn't mounted
  // until the Runs tab is opened — don't hold a process query + watch
  // subscription for a tab that may never be shown.
  const isAdvanced = useIsAdvanced();
  const { windows: sideWindows } = useSideWindows();

  const { processes: pastRunProcesses } = useProcessesForTarget(chatTarget ?? '', {
    enabled: !!chatTarget && isAdvanced && sideWindows.includes('runs'),
    processType: ProcessKind.Execution,
  });

  const runHistory = useMemo<ProcessEntry[]>(() => {
    const sorted = [...pastRunProcesses].sort((a, b) => toMs(b.created_date) - toMs(a.created_date));
    return sorted.map((p) => ({ process: p }));
  }, [pastRunProcesses]);

  const runsTab: ExtraSideTab = {
    id: 'runs',
    label: runHistory.length > 0 ? `Runs ${runHistory.length}` : 'Runs',
    icon: History,
    description: 'Runs on this file',
    panel: <ProcessRunsPanel entries={runHistory} />,
  };

  return (
    <AssetCollisionProvider entity={entity}>
      <MarkdownEditor
        fsRef={editorRef}
        chatTarget={chatTarget}
        extraSideTabs={[translationsTab, runsTab]}
        onDelete={deletable?.delete ? onDelete : undefined}
        deleteLabel={deletable?.name ?? undefined}
        reloadKey={reloadKey}
        fragment={fragment}
        wikiLinkTarget={wikiLinkTarget}
      />
    </AssetCollisionProvider>
  );
}
