import { Trans, useLingui } from '@lingui/react/macro';
import type Graph from 'graphology';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GraphEngine, type NodeData } from './graph/graphEngine';
import { AtlasGraphRenderer } from './graph/AtlasGraphRenderer';
import type { GraphRenderer } from './graph/graphRenderer';
import { loadDepGraph, rebuildDepGraph, type GraphLayout } from './graph/loadDepGraph';
import { loadWorldView, refreshWorldView } from './graph/loadWorldView';
import { heatSummaryForGraph } from './graph/heat';
import type { Theme } from './graph/themeColors';
import { HeatLegend } from './ui/HeatLegend';
import { PropertyPanel } from './ui/PropertyPanel';
import { TopBar } from './ui/TopBar';
import { useGraphUrlState, type SubgraphCodec } from './url-state';
import { SURFACE, type GraphSurface } from './surfaces';
import type { WorldViewColorMode } from '@src/types/WorldViewColorMode';
import { WorldViewProjection } from '@sdk';
import { OrgNodeManagement } from '@src/components/organization/org-node-management';
import type { GraphPresentation } from '@src/types/GraphPresentation';
import { Network, Orbit, RotateCcw, ZoomIn, ZoomOut, X } from 'lucide-react';
import './graph-view.css';

export type GraphViewProps = {
  surface?: GraphSurface;
  /** subgraph surface only: the pointer grammar of the owning view type. */
  codec?: SubgraphCodec;
  /** subgraph surface only: fetches the graph. MUST be referentially stable
   *  (useCallback) — it participates in the load effect's deps. */
  load?: () => Promise<Graph>;
  /** Layout override; defaults to the surface's static layout. */
  layout?: GraphLayout;
  /** Title override for the top bar. */
  title?: string;
  /** Double-click routing for subgraph node types. Return 'focus' for the
   *  standard local-zoom, or 'handled' when the surface navigated elsewhere
   *  itself (surfaces own cross-view navigation; this canvas only owns its own
   *  URL state). Default (undefined) keeps the standard focus behavior. */
  onNodeDoubleClickIntent?: (node: NodeData) => 'focus' | 'handled';
  /** Controls owned by the surface (e.g. the tag graph's shape toggle).
   *  Rendered in the SAME cluster as the renderer toggle so surfaces never
   *  grow their own competing absolutely-positioned buttons. */
  surfaceControls?: ReactNode;
};

type PendingGraph = {
  surface: GraphSurface;
  projection: WorldViewProjection | null;
  graph: Graph;
};

/**
 * Shared graph canvas. The backend projection and layout strategy are injected
 * by `surface`; URL state, filters, selection, properties, and Sigma rendering
 * remain one implementation. The `subgraph` surface is fully parameterized:
 * pointer grammar via `codec`, data via `load`, presentation via `layout`.
 */
export function GraphView({
  surface = 'dependency',
  codec,
  load,
  layout: layoutOverride,
  title: titleOverride,
  onNodeDoubleClickIntent,
  surfaceControls,
}: GraphViewProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const theme: Theme = resolvedTheme === 'light' ? 'light' : 'dark';
  const { state: urlState, setState: setUrlState } = useGraphUrlState(surface, codec);
  const spec = SURFACE[surface];
  const layout = layoutOverride ?? spec.layout;

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GraphRenderer | null>(null);
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

  const doubleClickIntentRef = useRef(onNodeDoubleClickIntent);
  doubleClickIntentRef.current = onNodeDoubleClickIntent;
  const navigateFocus = useCallback((key: string) => {
    const intentFn = doubleClickIntentRef.current;
    if (intentFn) {
      const node = engineRef.current?.getNodeData(key);
      // 'handled' = the surface navigated to another view itself.
      if (node && intentFn(node) === 'handled') return;
    }
    setUrlStateRef.current({ focus: key, selected: key });
  }, []);

  const projection = urlState.projection ?? WorldViewProjection.DEPLOYMENT;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const pending = pendingGraphRef.current;
        pendingGraphRef.current = null;
        let nextGraph: Graph;
        if (pending?.surface === surface && pending.projection === (surface === 'worldview' ? projection : null)) {
          nextGraph = pending.graph;
        } else if (surface === 'subgraph' && load) {
          nextGraph = await load();
        } else if (surface === 'worldview') {
          nextGraph = await loadWorldView(projection);
        } else {
          nextGraph = await loadDepGraph();
        }
        if (cancelled) return;
        setGraph(nextGraph);
        setLoading(false);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [layout, load, navigateFocus, navigateSelection, projection, reloadKey, surface]);

  useEffect(() => {
    if (!containerRef.current || !graph) return;
    const renderer: GraphRenderer =
      spec.presentation && urlState.presentation === 'atlas'
        ? // One `layout` request, two renderers: a hierarchical layout means the
          // Atlas tree arrangement, anything else its radial one.
          new AtlasGraphRenderer(graph, layout === 'dagre' ? 'tree' : 'radial')
        : new GraphEngine(graph, layout);
    engineRef.current = renderer;
    const unsubscribeSelect = renderer.onNodeSelect(navigateSelection);
    const unsubscribeDoubleClick = renderer.onNodeDoubleClick(navigateFocus);
    const requested = urlStateRef.current;
    renderer.setColorMode(spec.signals && projection === WorldViewProjection.DEPLOYMENT ? requested.signal : 'type');
    renderer.init(containerRef.current);
    renderer.setTheme(themeRef.current);
    renderer.setHiddenTypes(requested.hidden);
    const local =
      requested.focus && graph.hasNode(requested.focus)
        ? renderer.setLocalMode(requested.focus, requested.depth)
        : renderer.setLocalMode(null);
    setLocalVisibleCount(local.visibleCount);
    renderer.selectNode(requested.selected && graph.hasNode(requested.selected) ? requested.selected : null);
    return () => {
      unsubscribeSelect();
      unsubscribeDoubleClick();
      renderer.destroy();
      if (engineRef.current === renderer) engineRef.current = null;
    };
  }, [graph, layout, navigateFocus, navigateSelection, projection, spec, urlState.presentation]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (spec.signals) {
      engineRef.current?.setColorMode(projection === WorldViewProjection.DEPLOYMENT ? urlState.signal : 'type');
    }
  }, [projection, spec, urlState.signal]);

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
      setLocalVisibleCount(spec.countsWhenUnfocused ? graph.order : 0);
    }
    engine.selectNode(urlState.selected && graph.hasNode(urlState.selected) ? urlState.selected : null);
  }, [graph, spec, urlState.depth, urlState.focus, urlState.selected]);

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
      if (surface === 'subgraph' && load) {
        // Projections are derived server-side on every fetch — refresh = refetch.
        pendingGraphRef.current = { surface, projection: null, graph: await load() };
      } else if (surface === 'worldview') {
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
  }, [load, projection, surface]);

  const handleDepth = useCallback((depth: number) => setUrlState({ depth }), [setUrlState]);
  const handleColorMode = useCallback((signal: WorldViewColorMode) => setUrlState({ signal }), [setUrlState]);
  const handlePresentation = useCallback(
    (presentation: GraphPresentation) => setUrlState({ presentation }),
    [setUrlState],
  );
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
  const refreshes = spec.action === 'refresh';
  let title = t`Context Graph`;
  if (isWorldView) {
    if (projection === WorldViewProjection.WORLD) title = t`Your WorldView`;
    else if (projection === WorldViewProjection.ORGANIZATION) title = t`Organization WorldView`;
    else title = t`Deployment WorldView`;
  }
  if (titleOverride) title = titleOverride;
  const supportsSignals =
    spec.signals && projection === WorldViewProjection.DEPLOYMENT && urlState.presentation === 'sigma';
  // Atlas swaps the whole chrome (own controls + drawer instead of the panel),
  // so every atlas-specific branch keys on the ACTIVE renderer, not a surface.
  const atlasActive = spec.presentation && urlState.presentation === 'atlas';
  const loadingLabel = isWorldView ? t`Loading WorldView…` : title;
  const sourceLabel = isWorldView
    ? `/api/v1/worldview/${projection}`
    : surface === 'subgraph'
      ? t`subgraph projection`
      : '/api/v1/dep_graph';
  const heatSummary = useMemo(
    () => (supportsSignals && graph ? heatSummaryForGraph(graph, urlState.signal) : null),
    [graph, supportsSignals, urlState.signal],
  );

  return (
    <div
      className="graph-view-root"
      data-theme={theme}
      data-surface={surface}
      data-presentation={spec.presentation ? urlState.presentation : undefined}
      data-node-count={nodeCount}
      data-edge-count={edgeCount}
    >
      <div className="app">
        <div className="main-col">
          <TopBar
            title={title}
            actionLabel={refreshes ? t`Refresh` : t`Rebuild`}
            actionPendingLabel={refreshes ? t`Refreshing…` : t`Building…`}
            graph={graph}
            nodeCount={nodeCount}
            visibleNodeCount={visibleNodeCount}
            edgeCount={edgeCount}
            hidden={urlState.hidden}
            building={acting}
            actionDisabled={loading}
            depthOptions={spec.depthOptions}
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
            {(spec.presentation || surfaceControls) && (
              <div className="graph-controls-cluster">
                {surfaceControls}
                {spec.presentation && (
                  <div className="graph-segmented-toggle" role="group" aria-label={t`Graph presentation`}>
                    <button
                      type="button"
                      data-testid="worldview-view-sigma"
                      className={urlState.presentation === 'sigma' ? 'active' : ''}
                      aria-pressed={urlState.presentation === 'sigma'}
                      onClick={() => handlePresentation('sigma')}
                      title={t`Sigma graph view`}
                    >
                      <Network size={15} />
                      <span>Sigma</span>
                    </button>
                    <button
                      type="button"
                      data-testid="worldview-view-atlas"
                      className={urlState.presentation === 'atlas' ? 'active' : ''}
                      aria-pressed={urlState.presentation === 'atlas'}
                      onClick={() => handlePresentation('atlas')}
                      title={t`Atlas map view`}
                    >
                      <Orbit size={15} />
                      <span>Atlas</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {atlasActive && (
              <div className="atlas-controls" aria-label={t`Atlas controls`}>
                <button
                  type="button"
                  onClick={() => (engineRef.current as AtlasGraphRenderer | null)?.setMode('radial')}
                  title={t`Radial layout`}
                >
                  <Orbit size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => (engineRef.current as AtlasGraphRenderer | null)?.setMode('tree')}
                  title={t`Tree layout`}
                >
                  <Network size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => (engineRef.current as AtlasGraphRenderer | null)?.zoomBy(1.2)}
                  title={t`Zoom in`}
                >
                  <ZoomIn size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => (engineRef.current as AtlasGraphRenderer | null)?.zoomBy(0.8)}
                  title={t`Zoom out`}
                >
                  <ZoomOut size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => (engineRef.current as AtlasGraphRenderer | null)?.fit()}
                  title={t`Fit Atlas`}
                >
                  <RotateCcw size={15} />
                </button>
              </div>
            )}
            {atlasActive && (
              <AtlasDrawer
                node={selected}
                projection={surface === 'worldview' ? projection : null}
                localRootKey={urlState.focus}
                onClose={() => navigateSelection(null)}
                onNeighborClick={navigateSelection}
                onFocus={navigateFocus}
                onStructureChanged={() => setReloadKey((k) => k + 1)}
              />
            )}
            {loading && (
              <div className="overlay">
                <div className="spinner" />
                <p>{loadingLabel}</p>
                <p className="sub">{sourceLabel}</p>
              </div>
            )}
            {error && !loading && (
              <div className="overlay error">
                <p>{isWorldView ? <Trans>Failed to load WorldView</Trans> : <Trans>Failed to load graph</Trans>}</p>
                <p className="sub">{sourceLabel}</p>
                <p className="sub">{error}</p>
              </div>
            )}
            {heatSummary && !loading && !error && <HeatLegend summary={heatSummary} />}
          </div>
        </div>
        {!atlasActive ? (
          <PropertyPanel
            node={selected}
            localRootKey={urlState.focus}
            showWorldViewProperties={spec.signals}
            onNeighborClick={(key) => navigateSelection(key)}
            onFocus={navigateFocus}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Node types the Organization WorldView lets you administer in place. A ``user``
 *  node is deliberately absent: people are managed from the org or class they
 *  belong to, and the hub refuses a user as a membership target outright. */
const MANAGEABLE_ORG_TYPES = new Set(['organization', 'team']);

function AtlasDrawer({
  node,
  projection,
  localRootKey,
  onClose,
  onNeighborClick,
  onFocus,
  onStructureChanged,
}: {
  node: NodeData | null;
  projection: WorldViewProjection | null;
  localRootKey: string | null;
  onClose: () => void;
  onNeighborClick: (key: string) => void;
  onFocus: (key: string) => void;
  onStructureChanged?: () => void;
}) {
  const { t } = useLingui();
  if (!node) return null;
  return (
    <>
      <div className="atlas-drawer-scrim" onClick={onClose} />
      <aside className="atlas-drawer open" data-testid="atlas-drawer">
        <>
          <div className="atlas-drawer-header">
            <div>
              <span className="atlas-drawer-kicker">{node.type}</span>
              <h2>{node.label}</h2>
            </div>
            <button type="button" className="atlas-drawer-close" onClick={onClose} aria-label={t`Close details`}>
              <X size={16} />
            </button>
          </div>
          <button
            type="button"
            className="atlas-drawer-focus"
            onClick={() => onFocus(node.key)}
            disabled={localRootKey === node.key}
          >
            {localRootKey === node.key ? <Trans>Focused</Trans> : <Trans>Focus local graph</Trans>}
          </button>
          {/* Management, not graph debug: on the ORGANIZATION projection a school or
              class node is a thing you administer, so its roster and controls come
              first. Every other projection (and a user node) keeps the drawer purely
              informational. */}
          {projection === WorldViewProjection.ORGANIZATION && MANAGEABLE_ORG_TYPES.has(node.type) && (
            <OrgNodeManagement
              nodeType={node.type}
              nodeId={node.id}
              nodeLabel={node.label}
              onStructureChanged={onStructureChanged}
            />
          )}
          <div className="atlas-drawer-section">
            <h3>
              <Trans>Identity</Trans>
            </h3>
            <div className="atlas-drawer-row">
              <span>id</span>
              <code>{node.id}</code>
            </div>
            <div className="atlas-drawer-row">
              <span>degree</span>
              <strong>{node.degree}</strong>
            </div>
          </div>
          <div className="atlas-drawer-section">
            <h3>
              <Trans>Edges</Trans>
            </h3>
            {Object.entries(node.edgeCounts).map(([kind, count]) => (
              <div className="atlas-drawer-row" key={kind}>
                <span>{kind}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          {node.neighbors.length > 0 && (
            <div className="atlas-drawer-section">
              <h3>
                <Trans>Neighbors</Trans>
              </h3>
              {node.neighbors.slice(0, 20).map((neighbor) => (
                <button
                  type="button"
                  className="atlas-drawer-neighbor"
                  key={`${neighbor.key}-${neighbor.edgeKind}`}
                  onClick={() => onNeighborClick(neighbor.key)}
                >
                  <span>{neighbor.label}</span>
                  <small>{neighbor.edgeKind}</small>
                </button>
              ))}
            </div>
          )}
        </>
      </aside>
    </>
  );
}

export function WorldView() {
  return <GraphView surface="worldview" />;
}
