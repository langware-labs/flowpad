import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { sdkConfig } from '@sdk/config/index';

type GraphNode = {
  type: string;
  id: string;
  label: string | null;
  is_ghost: boolean;
  key: string;
};
type GraphEdge = {
  from: { type: string; id: string };
  to: { type: string; id: string };
  kind: 'child' | 'context_shared' | 'context_private';
};
type GraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: { nodes: number; edges: number };
  duration_ms: number;
};

const KIND_COLOR: Record<GraphEdge['kind'], string> = {
  child: '#6366f1',
  context_shared: '#10b981',
  context_private: '#f59e0b',
};

const LAYOUT = {
  name: 'cose',
  animate: false,
  padding: 24,
  nodeRepulsion: () => 8000,
  idealEdgeLength: () => 60,
  numIter: 500,
};

const CYTOSCAPE_STYLE: cytoscape.Stylesheet[] = [
  {
    selector: 'node',
    style: {
      'background-color': '#1e293b',
      label: 'data(label)',
      color: '#e2e8f0',
      'font-size': 10,
      'text-valign': 'bottom',
      'text-margin-y': 4,
      width: 18,
      height: 18,
    },
  },
  {
    selector: 'node.is-ghost',
    style: {
      'background-color': '#475569',
      'border-width': 1,
      'border-color': '#94a3b8',
      'border-style': 'dashed',
    },
  },
  {
    selector: 'node.orphan',
    style: { display: 'none' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.2,
      'line-color': (ele: cytoscape.EdgeSingular) => KIND_COLOR[ele.data('kind') as GraphEdge['kind']] || '#94a3b8',
      'target-arrow-color': (ele: cytoscape.EdgeSingular) => KIND_COLOR[ele.data('kind') as GraphEdge['kind']] || '#94a3b8',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'arrow-scale': 0.8,
      opacity: 0.7,
    },
  },
];

function toCytoscapeElements(graph: GraphResponse, orphanKeys: Set<string>): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  for (const n of graph.nodes) {
    const classes: string[] = [];
    if (n.is_ghost) classes.push('is-ghost');
    if (orphanKeys.has(n.key)) classes.push('orphan');
    els.push({
      group: 'nodes',
      data: { id: n.key, label: n.label || `${n.type}-${n.id.slice(0, 6)}`, type: n.type },
      classes: classes.join(' ') || undefined,
    });
  }
  for (const [i, e] of graph.edges.entries()) {
    els.push({
      group: 'edges',
      data: {
        id: `e-${i}`,
        source: `${e.from.type}-${e.from.id}`,
        target: `${e.to.type}-${e.to.id}`,
        kind: e.kind,
      },
    });
  }
  return els;
}

export default function GraphPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOrphans, setShowOrphans] = useState(false);

  const orphanKeys = useMemo(() => {
    if (!graph) return new Set<string>();
    const connected = new Set<string>();
    for (const e of graph.edges) {
      connected.add(`${e.from.type}-${e.from.id}`);
      connected.add(`${e.to.type}-${e.to.id}`);
    }
    const orphans = new Set<string>();
    for (const n of graph.nodes) if (!connected.has(n.key)) orphans.add(n.key);
    return orphans;
  }, [graph]);

  const fetchGraph = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${sdkConfig.apiUrl}/api/v1/dep_graph`, { credentials: 'include' });
      if (!res.ok) throw new Error(`GET failed: ${res.status}`);
      setGraph(await res.json());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const rebuild = useCallback(async () => {
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch(`${sdkConfig.apiUrl}/api/v1/dep_graph/build`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`POST failed: ${res.status}`);
      await fetchGraph();
    } catch (e) {
      setError(String(e));
    } finally {
      setBuilding(false);
    }
  }, [fetchGraph]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const elements = useMemo(
    () => (graph ? toCytoscapeElements(graph, orphanKeys) : []),
    [graph, orphanKeys],
  );

  // Build / destroy the Cytoscape instance only when the graph identity
  // changes — orphan toggling is handled by the class-flip effect below.
  useEffect(() => {
    if (!containerRef.current || !graph) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: CYTOSCAPE_STYLE,
      layout: LAYOUT,
      wheelSensitivity: 0.2,
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const k = n.id();
        if (orphanKeys.has(k)) n.toggleClass('orphan', !showOrphans);
      });
    });
  }, [showOrphans, orphanKeys]);

  return (
    <div data-testid="dep-graph-page" className="flex h-full w-full flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm">
        <button
          onClick={rebuild}
          disabled={building}
          className="rounded border border-border bg-muted px-3 py-1 hover:bg-accent disabled:opacity-50"
        >
          {building ? 'Building…' : 'Rebuild'}
        </button>
        {graph && (
          <span className="text-muted-foreground">
            {graph.counts.nodes} nodes · {graph.counts.edges} edges
          </span>
        )}
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showOrphans}
            onChange={(e) => setShowOrphans(e.target.checked)}
          />
          show orphans
        </label>
        {error && <span className="text-red-500">{error}</span>}
        <span className="ml-auto flex gap-3 text-xs text-muted-foreground">
          {Object.entries(KIND_COLOR).map(([kind, color]) => (
            <span key={kind} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
              {kind}
            </span>
          ))}
        </span>
      </div>
      <div ref={containerRef} className="flex-1" />
    </div>
  );
}
