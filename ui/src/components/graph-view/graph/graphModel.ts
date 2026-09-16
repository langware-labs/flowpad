import type Graph from 'graphology';

export type NodeData = {
  key: string;
  type: string;
  id: string;
  label: string;
  isGhost: boolean;
  community: number;
  color: string;
  degree: number;
  properties: Record<string, unknown>;
  neighbors: Array<{
    key: string;
    type: string;
    label: string;
    edgeKind: string;
  }>;
  edgeCounts: Record<string, number>;
  /**
   * The container this node hangs off, if any — the source of its incoming
   * HIERARCHY edge. Read off the graph the client already has rather than asking
   * the hub: `children`/`parent` are stubbed to an empty body, and while
   * `parents_path` IS implemented it costs a round-trip per selection to learn
   * something the projection already carries in `topology`.
   *
   * Null for a root, for a node whose parent is outside the caller's reachable
   * set, and on projections that report no hierarchy at all.
   */
  parent: { key: string; type: string; id: string; label: string } | null;
};

export type SearchResult = { key: string; label: string; type: string; id: string };

export function nodeDataForGraph(graph: Graph, key: string): NodeData | null {
  if (!graph.hasNode(key)) return null;
  const attrs = graph.getNodeAttributes(key);
  const edgeCounts: Record<string, number> = {};
  const neighbors: NodeData['neighbors'] = [];
  let parent: NodeData['parent'] = null;
  graph.forEachEdge(key, (_edge, edgeAttrs, source, target) => {
    const kind = (edgeAttrs.kind as string) ?? 'unknown';
    edgeCounts[kind] = (edgeCounts[kind] ?? 0) + 1;
    const other = source === key ? target : source;
    // INCOMING hierarchy only: the edge runs parent -> child, so an outgoing one
    // would name a child and calling it the parent inverts the whole pane.
    if (!parent && target === key && edgeAttrs.topology === 'hierarchy') {
      parent = {
        key: other,
        type: graph.getNodeAttribute(other, 'entityType') as string,
        id: graph.getNodeAttribute(other, 'entityId') as string,
        label: graph.getNodeAttribute(other, 'label') as string,
      };
    }
    if (neighbors.length < 30) {
      neighbors.push({
        key: other,
        type: graph.getNodeAttribute(other, 'entityType') as string,
        label: graph.getNodeAttribute(other, 'label') as string,
        edgeKind: kind,
      });
    }
  });
  return {
    key,
    type: attrs.entityType as string,
    id: attrs.entityId as string,
    label: attrs.label as string,
    isGhost: (attrs.isGhost as boolean) ?? false,
    community: (attrs.community as number) ?? 0,
    color: (attrs.color as string) ?? '#64748b',
    degree: graph.degree(key),
    properties:
      attrs.properties && typeof attrs.properties === 'object' ? (attrs.properties as Record<string, unknown>) : {},
    neighbors,
    edgeCounts,
    parent,
  };
}

export function searchGraph(graph: Graph, query: string, limit = 8): SearchResult[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const results: Array<SearchResult & { score: number }> = [];
  graph.forEachNode((node, attrs) => {
    const label = ((attrs.label as string) ?? '').toLowerCase();
    const id = (attrs.entityId as string) ?? '';
    const idSearch = id.toLowerCase();
    let score = -1;
    if (label === q) score = 0;
    else if (label.startsWith(q)) score = 1;
    else if (label.includes(q)) score = 2;
    else if (idSearch.startsWith(q)) score = 3;
    else if (idSearch.includes(q)) score = 4;
    if (score >= 0) results.push({ key: node, label: attrs.label as string, type: attrs.entityType as string, id, score });
  });
  results.sort((a, b) => a.score - b.score || a.label.length - b.label.length);
  return results.slice(0, limit).map(({ key, label, type, id }) => ({ key, label, type, id }));
}
