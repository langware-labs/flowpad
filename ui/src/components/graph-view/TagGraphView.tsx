import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useMemo } from 'react';
import { GitFork, Network } from 'lucide-react';
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from '@src/navigation/DockPointer';
import { buildDockPointer } from '@src/navigation/entity-pointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { NodeData } from './graph/graphEngine';
import { tagGraphCodec } from './codecs';
import { SubgraphView } from './SubgraphView';

export { tagGraphCodec } from './codecs';

/**
 * Layer 3 — the tag taxonomy view at `/dock/tag/graph[/<name>]`.
 * Thin by design: a codec (pointer grammar), a params map, and double-click
 * routing; everything else is the shared subgraph surface.
 *
 * `?view=tree` renders the ontology tree: hierarchy-only edges (server-side
 * `view=tree` filter) on the dagre layout, parents above children.
 */

/** Where an entity node opens. A markdown node keeps its file path; every other type opens by type + id. */
function entityPointer(node: NodeData): DockPointer | null {
  if (node.type === 'file') return null;
  const assetRef = (node.properties?.asset_ref as string | undefined) ?? '';
  if (node.type === 'markdown' && assetRef) {
    return DockPointer.forAssetEditor('markdown', assetRef);
  }
  return buildDockPointer({ type: node.type, id: node.id }, undefined);
}

export function TagGraphView() {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const activeDock = currentDock?.viewType === ViewType.TAG ? currentDock : null;
  const view = activeDock?.options?.view === 'tree' ? 'tree' : 'full';
  const tag = DockPointer.parseTagPointer(activeDock?.pointer)?.tag ?? null;

  const params = useMemo(() => {
    const out: Record<string, string> = {};
    if (view === 'tree') out.view = 'tree';
    return out;
  }, [view]);

  // Tag nodes zoom in place; entity nodes leave for their own view — this
  // surface performs that navigation (the canvas only owns its own URL state).
  const onNodeDoubleClickIntent = useCallback(
    (node: NodeData): 'focus' | 'handled' => {
      if (node.type === 'tag') return 'focus';
      const pointer = entityPointer(node);
      if (pointer) navigation.openDock(pointer);
      return 'handled';
    },
    [navigation],
  );

  // Shape lives in `?view=`; the renderer lives in `?render=`. Carry the
  // renderer through so switching shape doesn't drop the user out of Atlas.
  const setShape = useCallback(
    (next: 'tree' | 'full') => {
      navigation.openDock(
        DockPointer.forTagGraph(tag, {
          view: next === 'tree' ? 'tree' : undefined,
          render: activeDock?.options?.render === 'atlas' ? 'atlas' : undefined,
        }),
      );
    },
    [activeDock?.options?.render, navigation, tag],
  );

  const shapeToggle = (
    <div className="graph-segmented-toggle" role="group" aria-label={t`Tag shape`}>
      <button
        type="button"
        className={view === 'full' ? 'active' : ''}
        aria-pressed={view === 'full'}
        onClick={() => setShape('full')}
        title={t`Graph — taxonomy plus bound assets`}
        data-tag="app.ui.button.clicked"
      >
        <GitFork size={15} />
        <span>
          <Trans>Graph</Trans>
        </span>
      </button>
      <button
        type="button"
        className={view === 'tree' ? 'active' : ''}
        aria-pressed={view === 'tree'}
        onClick={() => setShape('tree')}
        title={t`Tree — hierarchy only`}
        data-tag="app.ui.button.clicked"
      >
        <Network size={15} />
        <span>
          <Trans>Tree</Trans>
        </span>
      </button>
    </div>
  );

  return (
    <SubgraphView
      projection="tag"
      codec={tagGraphCodec}
      params={params}
      layout={view === 'tree' ? 'dagre' : 'force'}
      title={view === 'tree' ? t`Tag Tree` : t`Tag Graph`}
      onNodeDoubleClickIntent={onNodeDoubleClickIntent}
      surfaceControls={shapeToggle}
    />
  );
}
