import { Trans, useLingui } from '@lingui/react/macro';
import type Graph from 'graphology';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GraphEngine, type NodeData } from './graph/graphEngine';
import { loadDepGraph, rebuildDepGraph, type GraphLayout } from './graph/loadDepGraph';
import { loadWorldView, syncWorldView } from './graph/loadWorldView';
import { heatSummaryForGraph } from './graph/heat';
import type { Theme } from './graph/themeColors';
import { HeatLegend } from './ui/HeatLegend';
import { PropertyPanel } from './ui/PropertyPanel';
import { TopBar } from './ui/TopBar';
import { useGraphUrlState, type GraphSurface } from './url-state';
import type { WorldViewColorMode } from '@src/types/WorldViewColorMode';
import './graph-view.css';

export type GraphViewProps = {
  surface?: GraphSurface;
};

const SURFACE_LAYOUT: Record<GraphSurface, GraphLayout> = {
  dependency: 'force',
  worldview: 'force',
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
  const pendingGraphRef = useRef<Graph | null>(null);
  const urlStateRef = useRef(urlState);
  const setUrlStateRef = useRef(setUrlState);
  const themeRef = useRef(theme);
  urlStateRef.current = urlState;
  setUrlStateRef.current = setUrlState;
  themeRef.current = theme;

  const [graph, setGraph] = useState<Graph | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
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

  const navigateFocus = useCallback((key: string) => setUrlStateRef.current({ local: key, selected: key }), []);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const nextGraph =
          pendingGraphRef.current ?? (surface === 'worldview' ? await loadWorldView() : await loadDepGraph());
        pendingGraphRef.current = null;
        if (cancelled || !containerRef.current) return;

        const engine = new GraphEngine(nextGraph, SURFACE_LAYOUT[surface]);
        engineRef.current = engine;
        setGraph(nextGraph);
        setHidden(new Set());

        // Sigma event handlers only express navigation intent. The URL update
        // comes back through the sync effect below before selection/focus is
        // applied to the engine.
        const unsubscribeSelect = engine.onNodeSelect(navigateSelection);
        const unsubscribeDoubleClick = engine.onNodeDoubleClick(navigateFocus);

        requestAnimationFrame(() => {
          if (cancelled || !containerRef.current) return;
          const requested = urlStateRef.current;
          engine.setColorMode(requested.color);
          engine.init(containerRef.current);
          engine.setTheme(themeRef.current);
          const localFilter = requested.local && !(surface === 'worldview' && requested.depth === 0);
          if (localFilter && nextGraph.hasNode(requested.local!)) {
            const local = engine.setLocalMode(requested.local, requested.depth);
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
  }, [navigateFocus, navigateSelection, reloadKey, surface]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (surface === 'worldview') engineRef.current?.setColorMode(urlState.color);
  }, [surface, urlState.color]);

  // URL -> engine is the only path that applies selection and local focus.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !graph) return;
    const localFilter = urlState.local && !(surface === 'worldview' && urlState.depth === 0);
    if (localFilter && graph.hasNode(urlState.local!)) {
      const local = engine.setLocalMode(urlState.local, urlState.depth);
      setLocalVisibleCount(local.visibleCount);
    } else {
      engine.setLocalMode(null);
      setLocalVisibleCount(surface === 'worldview' ? graph.order : 0);
    }
    engine.selectNode(urlState.selected && graph.hasNode(urlState.selected) ? urlState.selected : null);
  }, [graph, surface, urlState.depth, urlState.local, urlState.selected]);

  const toggleType = useCallback((type: string) => {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      engineRef.current?.setHiddenTypes(next);
      return next;
    });
  }, []);

  const selectAllTypes = useCallback(() => {
    const empty = new Set<string>();
    engineRef.current?.setHiddenTypes(empty);
    setHidden(empty);
  }, []);

  const clearAllTypes = useCallback(() => {
    if (!graph) return;
    const all = new Set<string>();
    graph.forEachNode((_node, attributes) => all.add(attributes.entityType as string));
    engineRef.current?.setHiddenTypes(all);
    setHidden(all);
  }, [graph]);

  const handleAction = useCallback(async () => {
    setActing(true);
    setError(null);
    try {
      if (surface === 'worldview') {
        pendingGraphRef.current = await syncWorldView();
      } else {
        await rebuildDepGraph();
        pendingGraphRef.current = await loadDepGraph();
      }
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActing(false);
    }
  }, [surface]);

  const handleDepth = useCallback((depth: number) => setUrlState({ depth }), [setUrlState]);
  const handleColorMode = useCallback(
    (color: WorldViewColorMode) => setUrlState({ color }),
    [setUrlState],
  );
  const handleExitLocal = useCallback(() => setUrlState({ local: null }), [setUrlState]);
  const handleSearch = useCallback((query: string) => engineRef.current?.searchNodes(query) ?? [], []);

  const nodeCount = graph?.order ?? 0;
  const edgeCount = graph?.size ?? 0;
  const visibleNodeCount = useMemo(() => {
    if (!graph) return 0;
    if (hidden.size === 0) return graph.order;
    let count = 0;
    graph.forEachNode((_node, attributes) => {
      if (!hidden.has(attributes.entityType as string)) count += 1;
    });
    return count;
  }, [graph, hidden]);

  const isWorldView = surface === 'worldview';
  const title = isWorldView ? t`Cloud WorldView` : t`Context Graph`;
  const heatSummary = useMemo(
    () => (isWorldView && graph ? heatSummaryForGraph(graph, urlState.color) : null),
    [graph, isWorldView, urlState.color],
  );

  return (
    <div className="graph-view-root" data-theme={theme} data-surface={surface}>
      <div className="app">
        <div className="main-col">
          <TopBar
            title={title}
            actionLabel={isWorldView ? t`Sync` : t`Rebuild`}
            actionPendingLabel={isWorldView ? t`Syncing…` : t`Building…`}
            graph={graph}
            nodeCount={nodeCount}
            visibleNodeCount={visibleNodeCount}
            edgeCount={edgeCount}
            hidden={hidden}
            building={acting}
            actionDisabled={loading}
            depthOptions={isWorldView ? [0, 2, 4, 6] : [1, 2, 3]}
            colorMode={isWorldView ? urlState.color : undefined}
            localMode={
              urlState.local && graph?.hasNode(urlState.local)
                ? {
                    rootKey: urlState.local,
                    rootLabel: graph.getNodeAttribute(urlState.local, 'label') as string,
                    rootType: graph.getNodeAttribute(urlState.local, 'entityType') as string,
                    depth: urlState.depth,
                    visibleCount: localVisibleCount,
                  }
                : null
            }
            onToggleType={toggleType}
            onSelectAllTypes={selectAllTypes}
            onClearAllTypes={clearAllTypes}
            onSearch={handleSearch}
            onSelectResult={(key) => navigateSelection(key)}
            onRebuild={() => void handleAction()}
            onChangeDepth={handleDepth}
            onChangeColorMode={isWorldView ? handleColorMode : undefined}
            onExitLocal={handleExitLocal}
          />
          <div className="graph-container">
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
            {loading && (
              <div className="overlay">
                <div className="spinner" />
                <p>{isWorldView ? <Trans>Loading WorldView…</Trans> : <Trans>Loading dependency graph…</Trans>}</p>
                <p className="sub">{isWorldView ? '/api/v1/worldview' : '/api/v1/dep_graph'}</p>
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
          localRootKey={urlState.local}
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
