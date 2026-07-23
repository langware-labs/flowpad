import { useLingui } from '@lingui/react/macro';
import { useCallback, useMemo } from 'react';
import { GitFork, Network } from 'lucide-react';
import { TypeId } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { NodeData } from './graph/graphEngine';
import { topicGraphCodec } from './codecs';
import { SubgraphView } from './SubgraphView';

export { topicGraphCodec } from './codecs';

/**
 * Layer 3 — the topic taxonomy view at `/dock/topic/graph[/<name>]`.
 * Thin by design: a codec (pointer grammar), a params map, and double-click
 * routing; everything else is the shared subgraph surface.
 *
 * `?view=tree` renders the ontology tree: hierarchy-only edges (server-side
 * `view=tree` filter) on the dagre layout, parents above children.
 */

function assetEditorPointer(node: NodeData): DockPointer | null {
  const assetRef = (node.properties?.asset_ref as string | undefined) ?? '';
  if (node.entityType === 'markdown' && assetRef) {
    return DockPointer.forAssetEditor('markdown', assetRef);
  }
  if (node.entityType === 'skill') {
    try {
      return DockPointer.forAssetEditorByTypeId('skill', new TypeId('skill', node.entityId));
    } catch {
      return null;
    }
  }
  return null;
}

export function TopicGraphView() {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const activeDock = currentDock?.viewType === ViewType.TOPIC ? currentDock : null;
  const view = activeDock?.options?.view === 'tree' ? 'tree' : 'full';
  const topic = DockPointer.parseTopicPointer(activeDock?.pointer)?.topic ?? null;

  const params = useMemo(() => {
    const out: Record<string, string> = {};
    if (view === 'tree') out.view = 'tree';
    return out;
  }, [view]);

  // Topic nodes zoom in place; asset nodes leave for their own editor — this
  // surface performs that navigation (the canvas only owns its own URL state).
  const onNodeDoubleClickIntent = useCallback(
    (node: NodeData): 'focus' | 'handled' => {
      if (node.entityType === 'topic') return 'focus';
      const pointer = assetEditorPointer(node);
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
        DockPointer.forTopicGraph(topic, {
          view: next === 'tree' ? 'tree' : undefined,
          render: activeDock?.options?.render === 'atlas' ? 'atlas' : undefined,
        }),
      );
    },
    [activeDock?.options?.render, navigation, topic],
  );

  const shapeToggle = (
    <div className="graph-segmented-toggle" role="group" aria-label={t`Topic shape`}>
      <button
        type="button"
        className={view === 'full' ? 'active' : ''}
        aria-pressed={view === 'full'}
        onClick={() => setShape('full')}
        title={t`Graph — taxonomy plus bound assets`}
        data-topic="app.ui.button.clicked"
      >
        <GitFork size={15} />
        <span>Graph</span>
      </button>
      <button
        type="button"
        className={view === 'tree' ? 'active' : ''}
        aria-pressed={view === 'tree'}
        onClick={() => setShape('tree')}
        title={t`Tree — hierarchy only`}
        data-topic="app.ui.button.clicked"
      >
        <Network size={15} />
        <span>Tree</span>
      </button>
    </div>
  );

  return (
    <SubgraphView
      projection="topic"
      codec={topicGraphCodec}
      params={params}
      layout={view === 'tree' ? 'dagre' : 'force'}
      title={view === 'tree' ? t`Topic Tree` : t`Topic Graph`}
      onNodeDoubleClickIntent={onNodeDoubleClickIntent}
      surfaceControls={shapeToggle}
    />
  );
}
