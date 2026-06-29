import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Graph from 'graphology';
import { Trans } from '@lingui/react/macro';
import { GraphEngine, type NodeData } from './graph/graphEngine';
import { loadDepGraph } from './graph/loadDepGraph';
import type { Theme } from './graph/themeColors';
import { TopBar } from './ui/TopBar';
import { PropertyPanel } from './ui/PropertyPanel';
import { useGraphUrlState } from './url-state';
import './graph-view.css';

export function GraphView() {
  const { resolvedTheme } = useTheme();
  const theme: Theme = resolvedTheme === 'light' ? 'light' : 'dark';
  const { state: urlState, setState: setUrlState } = useGraphUrlState();

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  // Snapshot only used for the engine's initial setLocalMode/focusNode in the
  // mount effect. All subsequent URL changes (back/forward, deep-link replace)
  // flow through the sync effect below — never through this snapshot.
  const initialUrl = useRef(urlState).current;

  const [graph, setGraph] = useState<Graph | null>(null);
  const [selected, setSelected] = useState<NodeData | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [localRoot, setLocalRoot] = useState<string | null>(initialUrl.local);
  const [localDepth, setLocalDepth] = useState(initialUrl.depth);
  const localDepthRef = useRef(initialUrl.depth);
  const [localVisibleCount, setLocalVisibleCount] = useState(0);
  const selectedKey = selected?.key ?? null;

  const handleFocus = useCallback((key: string) => {
    if (!engineRef.current) return;
    const state = engineRef.current.setLocalMode(key, localDepthRef.current);
    setLocalRoot(state.root);
    setLocalVisibleCount(state.visibleCount);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    setLoading(true);
    setError(null);
    setSelected(null);

    (async () => {
      try {
        const g = await loadDepGraph();
        if (cancelled || !containerRef.current) return;
        const engine = new GraphEngine(g);
        engineRef.current = engine;
        setGraph(g);

        const unsubSelect = engine.onNodeSelect((key) => {
          setSelected(key ? engine.getNodeData(key) : null);
        });
        const unsubDouble = engine.onNodeDoubleClick((key) => {
          handleFocus(key);
        });

        requestAnimationFrame(() => {
          if (cancelled || !containerRef.current) return;
          engine.init(containerRef.current);
          engine.setTheme(theme);
          setLoading(false);

          // Apply initial local-mode only if the requested node exists in this
          // build of the graph. If it doesn't, leave the URL alone — the user's
          // deep link stays intact for when the graph is rebuilt.
          if (initialUrl.local && g.hasNode(initialUrl.local)) {
            engine.setLocalMode(initialUrl.local, initialUrl.depth);
            setLocalVisibleCount(engine.getLocalState().visibleCount);
          }
          if (initialUrl.selected && g.hasNode(initialUrl.selected)) {
            if (initialUrl.local) engine.selectNode(initialUrl.selected);
            else engine.focusNode(initialUrl.selected);
          }
        });

        cleanup = () => {
          unsubSelect();
          unsubDouble();
          engine.destroy();
          engineRef.current = null;
        };
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Push theme changes into the engine.
  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  // Sync engine + React state when the URL changes externally (browser
  // back/forward, deep-link to a different node, programmatic replace).
  // Internal user actions also bump urlState through setUrlState, but the
  // comparison short-circuits when state already matches.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !graph) return;
    if (urlState.local !== localRoot || urlState.depth !== localDepth) {
      setLocalRoot(urlState.local);
      setLocalDepth(urlState.depth);
      localDepthRef.current = urlState.depth;
      if (urlState.local && graph.hasNode(urlState.local)) {
        const s = engine.setLocalMode(urlState.local, urlState.depth);
        setLocalVisibleCount(s.visibleCount);
      } else if (!urlState.local) {
        engine.setLocalMode(null);
        setLocalVisibleCount(0);
      }
    }
    if (urlState.selected !== selectedKey) {
      if (urlState.selected && graph.hasNode(urlState.selected)) {
        engine.selectNode(urlState.selected);
      } else if (!urlState.selected) {
        engine.selectNode(null);
      }
    }
    // localRoot/localDepth/selectedKey deliberately omitted — including them
    // would cause this effect to re-fire on every internal state change and
    // fight with the URL-write effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlState.local, urlState.depth, urlState.selected, graph]);

  const toggleType = useCallback((type: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
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
    graph.forEachNode((_, attrs) => all.add(attrs.entityType as string));
    engineRef.current?.setHiddenTypes(all);
    setHidden(all);
  }, [graph]);

  const handleChangeDepth = useCallback(
    (depth: number) => {
      localDepthRef.current = depth;
      setLocalDepth(depth);
      if (!engineRef.current || !localRoot) return;
      const state = engineRef.current.setLocalMode(localRoot, depth);
      setLocalVisibleCount(state.visibleCount);
    },
    [localRoot],
  );

  const handleExitLocal = useCallback(() => {
    engineRef.current?.setLocalMode(null);
    setLocalRoot(null);
    setLocalVisibleCount(0);
  }, []);

  // Sync internal state → URL (skip the initial mount). The URL-state hook's
  // setUrlState → navigation.openDock dedupes when nothing actually changed,
  // so the URL→state sync effect above doesn't ping-pong with this one.
  const skipFirstUrlWrite = useRef(true);
  useEffect(() => {
    if (skipFirstUrlWrite.current) {
      skipFirstUrlWrite.current = false;
      return;
    }
    setUrlState({ local: localRoot, selected: selectedKey, depth: localDepth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, localRoot, localDepth]);

  const handleSearch = useCallback((q: string) => engineRef.current?.searchNodes(q) ?? [], []);
  const handleSelectResult = useCallback((key: string) => engineRef.current?.focusNode(key), []);
  const handleNeighborClick = useCallback((key: string) => engineRef.current?.focusNode(key), []);

  const handleRebuild = useCallback(async () => {
    setBuilding(true);
    try {
      const res = await fetch('/api/v1/dep_graph/build', { method: 'POST' });
      if (!res.ok) throw new Error(`build failed: ${res.status}`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBuilding(false);
    }
  }, []);

  const nodeCount = graph?.order ?? 0;
  const edgeCount = graph?.size ?? 0;
  const visibleNodeCount = useMemo(() => {
    if (!graph) return 0;
    if (hidden.size === 0) return graph.order;
    let n = 0;
    graph.forEachNode((_, attrs) => {
      if (!hidden.has(attrs.entityType as string)) n += 1;
    });
    return n;
  }, [graph, hidden]);

  return (
    <div className="graph-view-root" data-theme={theme}>
      <div className="app">
        <div className="main-col">
          <TopBar
            graph={graph}
            nodeCount={nodeCount}
            visibleNodeCount={visibleNodeCount}
            edgeCount={edgeCount}
            hidden={hidden}
            building={building}
            localMode={
              localRoot && graph && graph.hasNode(localRoot)
                ? {
                    rootKey: localRoot,
                    rootLabel: graph.getNodeAttribute(localRoot, 'label') as string,
                    rootType: graph.getNodeAttribute(localRoot, 'entityType') as string,
                    depth: localDepth,
                    visibleCount: localVisibleCount,
                  }
                : null
            }
            onToggleType={toggleType}
            onSelectAllTypes={selectAllTypes}
            onClearAllTypes={clearAllTypes}
            onSearch={handleSearch}
            onSelectResult={handleSelectResult}
            onRebuild={handleRebuild}
            onChangeDepth={handleChangeDepth}
            onExitLocal={handleExitLocal}
          />
          <div className="graph-container">
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
            {loading && (
              <div className="overlay">
                <div className="spinner" />
                <p><Trans>Loading dep graph…</Trans></p>
                <p className="sub">via /api/v1/dep_graph</p>
              </div>
            )}
            {error && !loading && (
              <div className="overlay error">
                <p><Trans>Failed to load graph</Trans></p>
                <p className="sub">{error}</p>
              </div>
            )}
          </div>
        </div>
        <PropertyPanel
          node={selected}
          localRootKey={localRoot}
          onNeighborClick={handleNeighborClick}
          onFocus={handleFocus}
        />
      </div>
    </div>
  );
}
