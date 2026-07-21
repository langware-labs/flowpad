import { Trans, useLingui } from '@lingui/react/macro';
import type Graph from 'graphology';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GraphEngine, type NodeData } from './graph/graphEngine';
import { loadDepGraph, rebuildDepGraph, type GraphLayout } from './graph/loadDepGraph';
import { loadWorldView, refreshWorldView } from './graph/loadWorldView';
import { heatSummaryForGraph } from './graph/heat';
import type { Theme } from './graph/themeColors';
import { HeatLegend } from './ui/HeatLegend';
import { PropertyPanel } from './ui/PropertyPanel';
import { TopBar } from './ui/TopBar';
import { useGraphUrlState, type GraphSurface } from './url-state';
import type { WorldViewColorMode } from '@src/types/WorldViewColorMode';
import { WorldViewProjection } from '@sdk';
import './graph-view.css';

export type GraphViewProps = {
  surface?: GraphSurface;
};

type PendingGraph = {
  surface: GraphSurface;
  projection: WorldViewProjection | null;
  graph: Graph;
};

const SURFACE_LAYOUT: Record<GraphSurface, GraphLayout> = {
  dependency: 'force',
  worldview: 'circle',
};

/**
 * Shared graph canvas. The backend projection and layout strategy are injected
 * by `surface`; URL state, filters, selection, properties, and Sigma rendering
 * remain one implementation.
 */
export function GraphView({ surface = 'dependency' }: GraphViewProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const theme: Theme = resolvedTheme === 'light' ? 'light' : 'dark';
  const { state: urlState, setState: setUrlState } = useGraphUrlState(surface);

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const pendingGraphRef = useRef<PendingGraph | null>(null);
  const urlStateRef = useRef(urlState);
  const setUrlStateRef = useRef(setUrlState);
  const themeRef = useRef(theme);
  urlStateRef.current = urlState;
  setUrlStateRef.current = setUrlState;
  themeRef.current = theme;

  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [localVisibleCount, setLocalVisibleCount] = useState(0);

  const selected = useMemo<NodeData | null>(() => {
    if (!graph || !urlState.selected) return null;
    return engineRef.current?.getNodeData(urlState.selected) ?? null;
  }, [graph, urlState.selected]);

  const navigateSelection = useCallback((key: string | null) => setUrlStateRef.current({ selected: key }), []);

  const navigateFocus = useCallback((key: string) => setUrlStateRef.current({ focus: key, selected: key }), []);

  const projection = urlState.projection ?? WorldViewProjection.DEPLOYMENT;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const pending = pendingGraphRef.current;
        pendingGraphRef.current = null;
        let nextGraph: Graph;
        if (pending?.surface === surface && pending.projection === (surface === 'worldview' ? projection : null)) {
          nextGraph = pending.graph;
        } else if (surface === 'worldview') {
          nextGraph = await loadWorldView(projection);
        } else {
          nextGraph = await loadDepGraph();
        }
        if (cancelled || !containerRef.current) return;

        const engine = new GraphEngine(nextGraph, SURFACE_LAYOUT[surface]);
        engineRef.current = engine;
        setGraph(nextGraph);

        // Sigma event handlers only express navigation intent. The URL update
        // comes back through the sync effect below before selection/focus is
        // applied to the engine.
        const unsubscribeSelect = engine.onNodeSelect(navigateSelection);
        const unsubscribeDoubleClick = engine.onNodeDoubleClick(navigateFocus);

        requestAnimationFrame(() => {
          if (cancelled || !containerRef.current) return;
          const requested = urlStateRef.current;
          engine.setColorMode(
            surface === 'worldview' && projection === WorldViewProjection.DEPLOYMENT ? requested.signal : 'type',
          );
          engine.init(containerRef.current);
          engine.setTheme(themeRef.current);
          engine.setHiddenTypes(requested.hidden);
          if (requested.focus && nextGraph.hasNode(requested.focus)) {
            const local = engine.setLocalMode(requested.focus, requested.depth);
            setLocalVisibleCount(local.visibleCount);
          } else {
            engine.setLocalMode(null);
            setLocalVisibleCount(surface === 'worldview' ? nextGraph.order : 0);
          }
          if (requested.selected && nextGraph.hasNode(requested.selected)) {
            engine.selectNode(requested.selected);
          }
          setLoading(false);
        });

        cleanup = () => {
          unsubscribeSelect();
          unsubscribeDoubleClick();
          engine.destroy();
          if (engineRef.current === engine) engineRef.current = null;
        };
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [navigateFocus, navigateSelection, projection, reloadKey, surface]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (surface === 'worldview') {
      engineRef.current?.setColorMode(projection === WorldViewProjection.DEPLOYMENT ? urlState.signal : 'type');
    }
  }, [projection, surface, urlState.signal]);

  useEffect(() => {
    engineRef.current?.setHiddenTypes(urlState.hidden);
  }, [urlState.hidden]);

  // URL -> engine is the only path that applies selection and local focus.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !graph) return;
    if (urlState.focus && graph.hasNode(urlState.focus)) {
      const local = engine.setLocalMode(urlState.focus, urlState.depth);
      setLocalVisibleCount(local.visibleCount);
    } else {
      engine.setLocalMode(null);
      setLocalVisibleCount(surface === 'worldview' ? graph.order : 0);
    }
    engine.selectNode(urlState.selected && graph.hasNode(urlState.selected) ? urlState.selected : null);
  }, [graph, surface, urlState.depth, urlState.focus, urlState.selected]);

  const toggleType = useCallback((type: string) => {
    const next = new Set(urlStateRef.current.hidden);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setUrlStateRef.current({ hidden: next });
  }, []);

  const selectAllTypes = useCallback(() => {
    setUrlStateRef.current({ hidden: new Set() });
  }, []);

  const clearAllTypes = useCallback(() => {
    if (!graph) return;
    const all = new Set<string>();
    graph.forEachNode((_node, attributes) => all.add(attributes.entityType as string));
    setUrlStateRef.current({ hidden: all });
  }, [graph]);

  const handleAction = useCallback(async () => {
    setActing(true);
    setError(null);
    try {
      if (surface === 'worldview') {
        pendingGraphRef.current = {
          surface,
          projection,
          graph: await refreshWorldView(projection),
        };
      } else {
        await rebuildDepGraph();
        pendingGraphRef.current = {
          surface,
          projection: null,
          graph: await loadDepGraph(),
        };
      }
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActing(false);
    }
  }, [projection, surface]);

  const handleDepth = useCallback((depth: number) => setUrlState({ depth }), [setUrlState]);
  const handleColorMode = useCallback((signal: WorldViewColorMode) => setUrlState({ signal }), [setUrlState]);
  const handleExitLocal = useCallback(() => setUrlState({ focus: null }), [setUrlState]);
  const handleSearch = useCallback((query: string) => {
    if (query !== urlStateRef.current.query) setUrlStateRef.current({ query });
    return engineRef.current?.searchNodes(query) ?? [];
  }, []);

  const nodeCount = graph?.order ?? 0;
  const edgeCount = graph?.size ?? 0;
  const visibleNodeCount = useMemo(() => {
    if (!graph) return 0;
    if (urlState.hidden.size === 0) return graph.order;
    let count = 0;
    graph.forEachNode((_node, attributes) => {
      if (!urlState.hidden.has(attributes.entityType as string)) count += 1;
    });
    return count;
  }, [graph, urlState.hidden]);

  const isWorldView = surface === 'worldview';
  let title = t`Context Graph`;
  if (isWorldView) {
    if (projection === WorldViewProjection.WORLD) title = t`Your WorldView`;
    else if (projection === WorldViewProjection.ORGANIZATION) title = t`Organization WorldView`;
    else title = t`Deployment WorldView`;
  }
  const supportsSignals = isWorldView && projection === WorldViewProjection.DEPLOYMENT;
  const heatSummary = useMemo(
    () => (supportsSignals && graph ? heatSummaryForGraph(graph, urlState.signal) : null),
    [graph, supportsSignals, urlState.signal],
  );

  return (
    <div className="graph-view-root" data-theme={theme} data-surface={surface}>
      <div className="app">
        <div className="main-col">
          <TopBar
            title={title}
            actionLabel={isWorldView ? t`Refresh` : t`Rebuild`}
            actionPendingLabel={isWorldView ? t`Refreshing…` : t`Building…`}
            graph={graph}
            nodeCount={nodeCount}
            visibleNodeCount={visibleNodeCount}
            edgeCount={edgeCount}
            hidden={urlState.hidden}
            building={acting}
            actionDisabled={loading}
            depthOptions={isWorldView ? [1, 2, 4, 6, 12] : [1, 2, 3]}
            colorMode={supportsSignals ? urlState.signal : undefined}
            localMode={
              urlState.focus && graph?.hasNode(urlState.focus)
                ? {
                    rootKey: urlState.focus,
                    rootLabel: graph.getNodeAttribute(urlState.focus, 'label') as string,
                    rootType: graph.getNodeAttribute(urlState.focus, 'entityType') as string,
                    depth: urlState.depth,
                    visibleCount: localVisibleCount,
                  }
                : null
            }
            onToggleType={toggleType}
            onSelectAllTypes={selectAllTypes}
            onClearAllTypes={clearAllTypes}
            onSearch={handleSearch}
            searchQuery={urlState.query}
            onSelectResult={(key) => navigateSelection(key)}
            onRebuild={() => void handleAction()}
            onChangeDepth={handleDepth}
            onChangeColorMode={supportsSignals ? handleColorMode : undefined}
            onExitLocal={handleExitLocal}
          />
          <div className="graph-container">
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
            {loading && (
              <div className="overlay">
                <div className="spinner" />
                <p>{isWorldView ? <Trans>Loading WorldView…</Trans> : <Trans>Loading dependency graph…</Trans>}</p>
                <p className="sub">{isWorldView ? `/api/v1/worldview/${projection}` : '/api/v1/dep_graph'}</p>
              </div>
            )}
            {error && !loading && (
              <div className="overlay error">
                <p>{isWorldView ? <Trans>Failed to load WorldView</Trans> : <Trans>Failed to load graph</Trans>}</p>
                <p className="sub">{error}</p>
              </div>
            )}
            {heatSummary && !loading && !error && <HeatLegend summary={heatSummary} />}
          </div>
        </div>
        <PropertyPanel
          node={selected}
          localRootKey={urlState.focus}
          showWorldViewProperties={isWorldView}
          onNeighborClick={(key) => navigateSelection(key)}
          onFocus={navigateFocus}
        />
      </div>
    </div>
  );
}

export function WorldView() {
  return <GraphView surface="worldview" />;
}
