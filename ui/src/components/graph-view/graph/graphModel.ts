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
};

export type SearchResult = { key: string; label: string; type: string; id: string };

export function nodeDataForGraph(graph: Graph, key: string): NodeData | null {
  if (!graph.hasNode(key)) return null;
  const attrs = graph.getNodeAttributes(key);
  const edgeCounts: Record<string, number> = {};
  const neighbors: NodeData['neighbors'] = [];
  graph.forEachEdge(key, (_edge, edgeAttrs, source, target) => {
    const kind = (edgeAttrs.kind as string) ?? 'unknown';
    edgeCounts[kind] = (edgeCounts[kind] ?? 0) + 1;
    const other = source === key ? target : source;
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
