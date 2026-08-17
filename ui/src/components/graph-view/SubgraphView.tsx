import { useCallback, useMemo } from 'react';
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { genericSubgraphCodec } from './codecs';
import { GraphView, type GraphViewProps } from './GraphView';
import type { GraphLayout } from './graph/loadDepGraph';
import { loadSubgraph } from './graph/loadSubgraph';
import type { SubgraphCodec } from './url-state';

export { genericSubgraphCodec } from './codecs';

/**
 * Layer-2 frontend: render any named entity-subgraph projection on the shared
 * graph canvas. A thin view type supplies its pointer codec + params; data
 * comes from `/api/v1/subgraph/<projection>`.
 */
export type SubgraphViewProps = {
  projection: string;
  codec: SubgraphCodec;
  /** Extra query params for the projection builder (e.g. {root, view}).
   *  Stringly-typed by design — the backend builder parses its own. */
  params?: Record<string, string>;
  layout?: GraphLayout;
  title?: string;
  onNodeDoubleClickIntent?: GraphViewProps['onNodeDoubleClickIntent'];
  /** Surface-owned controls, rendered in the shared control cluster. */
  surfaceControls?: GraphViewProps['surfaceControls'];
};

export function SubgraphView({
  projection,
  codec,
  params,
  layout = 'force',
  title,
  onNodeDoubleClickIntent,
  surfaceControls,
}: SubgraphViewProps) {
  const paramsKey = JSON.stringify(params ?? {});
  const load = useCallback(
    () => loadSubgraph(projection, JSON.parse(paramsKey) as Record<string, string>, layout),
    [layout, paramsKey, projection],
  );
  return (
    <GraphView
      surface="subgraph"
      codec={codec}
      load={load}
      layout={layout}
      title={title}
      onNodeDoubleClickIntent={onNodeDoubleClickIntent}
      surfaceControls={surfaceControls}
    />
  );
}

/** Mounted by content-panel for ViewType.SUBGRAPH (`/dock/subgraph/...`) —
 *  reads the projection from the URL itself, so any registered backend
 *  projection renders with zero additional frontend code. */
export function GenericSubgraphView() {
  const { currentDock } = useDockNavigation();
  const activeDock = currentDock?.viewType === ViewType.SUBGRAPH ? currentDock : null;
  const projection = DockPointer.parseSubgraphPointer(activeDock?.pointer)?.projection ?? '';
  const codec = useMemo(() => genericSubgraphCodec(projection), [projection]);
  if (!projection) return null;
  return <SubgraphView projection={projection} codec={codec} title={`${projection} subgraph`} />;
}
