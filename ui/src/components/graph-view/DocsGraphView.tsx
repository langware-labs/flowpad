// DocsGraphView — the docs knowledge browser (ViewType.K_BROWSER).
//
// Reuses the same Sigma/graphology GraphEngine as the dep-graph, but is fed by a
// native LLMIndexer scan (/api/v1/docs-graph) and laid out as a hierarchical
// docs tree. The docs root is read from the dock pointer
// (/dock/k-browser/<vfs|typeid>/<value>); Refresh re-scans.

import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type Graph from 'graphology';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { GraphEngine, type NodeData } from './graph/graphEngine';
import { loadDocsGraph } from './graph/loadDocsGraph';
import type { Theme } from './graph/themeColors';
import './graph-view.css';

export function DocsGraphView() {
  const { resolvedTheme } = useTheme();
  const theme: Theme = resolvedTheme === 'light' ? 'light' : 'dark';
  const { currentDock } = useDockNavigation();

  const root = useMemo(() => {
    const parsed = DockPointer.parseKnowledgeBrowserPointer(currentDock?.pointer);
    return parsed?.value ?? '';
  }, [currentDock?.pointer]);

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selected, setSelected] = useState<NodeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!containerRef.current || !root) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    setLoading(true);
    setError(null);
    setSelected(null);

    (async () => {
      try {
        const g = await loadDocsGraph(root, { theme });
        if (cancelled || !containerRef.current) return;
        const engine = new GraphEngine(g);
        engineRef.current = engine;
        setGraph(g);

        const unsub = engine.onNodeSelect((key) => {
          setSelected(key ? engine.getNodeData(key) : null);
        });

        requestAnimationFrame(() => {
          if (cancelled || !containerRef.current) return;
          engine.init(containerRef.current);
          engine.setTheme(theme);
          setLoading(false);
        });

        cleanup = () => {
          unsub();
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
  }, [reloadKey, root]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div className="relative h-full w-full">
      <div className="absolute left-2 top-2 z-10 flex items-center gap-2 rounded-md bg-background/80 px-2 py-1 text-xs shadow-sm backdrop-blur">
        <button
          type="button"
          onClick={refresh}
          title="Rescan docs"
          className="flex items-center gap-1 hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
        <span className="text-muted-foreground">
          {graph ? `${graph.order} nodes · ${graph.size} edges` : '…'}
          {selected ? ` · ${selected.label}` : ''}
        </span>
      </div>
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive">
          {error}
        </div>
      )}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Scanning docs…
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
