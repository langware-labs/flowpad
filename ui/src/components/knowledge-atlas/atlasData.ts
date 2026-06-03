// Knowledge Atlas — data fetch + canvas layout.
//
// Port of the design's buildLayout() (canvas-app.jsx) generalized from the
// fixed root→section→doc three columns to an N-depth docs tree: the vault root
// is the dark root card, every folder is a section pill at its depth column,
// every file is a doc card. Cross-links ([[wiki]], kind "context_shared") bow
// out to the right of the deeper endpoint, exactly like the prototype.

export type GraphNodeIn = {
  type: string; // "markdown_index" (folder) | "markdown" (file)
  id: string;
  label: string;
  key: string;
  rel_path?: string;
};
export type GraphEdgeIn = {
  from: { type: string; id: string };
  to: { type: string; id: string };
  kind: string; // "child" | "context_shared"
};

export type AtlasNode = {
  id: string; // graph key
  type: 'root' | 'section' | 'doc';
  title: string;
  sub: string | null;
  kicker: string | null; // doc: parent folder label; root: "Knowledge Atlas"
  relPath: string;
  cx: number;
  cy: number;
  halfW: number;
  deg: number; // cross-link degree (doc badges)
};
export type AtlasEdge = { id: string; a: string; b: string };
export type AtlasLayout = {
  nodes: AtlasNode[];
  byId: Record<string, AtlasNode>;
  tedges: AtlasEdge[];
  xedges: AtlasEdge[];
  adj: Record<string, Set<string>>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  docCount: number;
};

const YGAP = 96;
const COL_X0 = 40;
const COL_GAP = 390; // matches the prototype's root(40)→section(410)→doc(820) rhythm
const HALF_W = { root: 112, doc: 104 };

const keyOf = (r: { type: string; id: string }) => `${r.type}-${r.id}`;

export async function fetchDocsGraph(root: string): Promise<{ nodes: GraphNodeIn[]; edges: GraphEdgeIn[] }> {
  const res = await fetch(`/api/v1/docs-graph?root=${encodeURIComponent(root)}`);
  if (!res.ok) throw new Error(`docs-graph fetch failed: ${res.status}`);
  const env = (await res.json()) as { data?: { nodes?: GraphNodeIn[]; edges?: GraphEdgeIn[] } } | null;
  return {
    nodes: Array.isArray(env?.data?.nodes) ? env!.data!.nodes! : [],
    edges: Array.isArray(env?.data?.edges) ? env!.data!.edges! : [],
  };
}

export async function fetchDoc(root: string, rel: string): Promise<{ title: string; content: string }> {
  const res = await fetch(
    `/api/v1/docs-graph/doc?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`,
  );
  if (!res.ok) throw new Error(`doc fetch failed: ${res.status}`);
  const env = (await res.json()) as { data?: { title?: string; content?: string } } | null;
  return { title: env?.data?.title ?? rel, content: env?.data?.content ?? '' };
}

export function buildAtlasLayout(nodesIn: GraphNodeIn[], edgesIn: GraphEdgeIn[]): AtlasLayout {
  const inByKey = new Map(nodesIn.map((n) => [n.key, n]));

  // Tree adjacency (child edges), ordered: folders first then files, by label —
  // gives the canvas its tidy section-above-docs rhythm.
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edgesIn) {
    if (e.kind !== 'child') continue;
    const p = keyOf(e.from);
    const c = keyOf(e.to);
    let arr = children.get(p);
    if (!arr) children.set(p, (arr = []));
    arr.push(c);
    hasParent.add(c);
  }
  const order = (k: string) => {
    const n = inByKey.get(k);
    return `${n?.type === 'markdown_index' ? '0' : '1'}:${n?.label ?? ''}`;
  };
  for (const arr of children.values()) arr.sort((a, b) => order(a).localeCompare(order(b)));

  const roots = nodesIn.filter((n) => !hasParent.has(n.key));
  const docCount = nodesIn.filter((n) => n.type === 'markdown').length;

  // Cross-link degree (badges count wiki links only, like the prototype).
  const xedges: AtlasEdge[] = [];
  const deg: Record<string, number> = {};
  const seen = new Set<string>();
  for (const e of edgesIn) {
    if (e.kind === 'child') continue;
    const a = keyOf(e.from);
    const b = keyOf(e.to);
    const dedup = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(dedup) || a === b) continue;
    seen.add(dedup);
    xedges.push({ id: `x:${dedup}`, a, b });
    deg[a] = (deg[a] ?? 0) + 1;
    deg[b] = (deg[b] ?? 0) + 1;
  }

  // Place nodes: leaves take successive rows; parents center on their children.
  const nodes: AtlasNode[] = [];
  const byId: Record<string, AtlasNode> = {};
  let row = 0;

  const place = (key: string, depth: number, parentLabel: string | null): number => {
    const src = inByKey.get(key);
    if (!src) return row;
    const kids = children.get(key) ?? [];
    let cy: number;
    const kidYs: number[] = [];
    if (kids.length === 0) {
      cy = row++ * YGAP;
    } else {
      for (const k of kids) kidYs.push(place(k, depth + 1, src.label));
      cy = (Math.min(...kidYs) + Math.max(...kidYs)) / 2;
    }

    const isFolder = src.type === 'markdown_index';
    const type: AtlasNode['type'] = depth === 0 ? 'root' : isFolder ? 'section' : 'doc';
    const halfW =
      type === 'root'
        ? HALF_W.root
        : type === 'section'
          ? Math.max(46, src.label.length * 5 + 34)
          : HALF_W.doc;
    const node: AtlasNode = {
      id: key,
      type,
      title: src.label || '/',
      sub: type === 'root' ? `${docCount} entries` : null,
      kicker: type === 'doc' ? parentLabel : type === 'root' ? 'Knowledge Atlas' : null,
      relPath: src.rel_path ?? '',
      cx: COL_X0 + depth * COL_GAP,
      cy,
      halfW,
      deg: deg[key] ?? 0,
    };
    nodes.push(node);
    byId[key] = node;
    return cy;
  };
  for (const r of roots) place(r.key, 0, null);

  // Structural edges follow the placed tree.
  const tedges: AtlasEdge[] = [];
  for (const [p, kids] of children) {
    if (!byId[p]) continue;
    for (const k of kids) if (byId[k]) tedges.push({ id: `t:${p}>${k}`, a: p, b: k });
  }

  const adj: Record<string, Set<string>> = {};
  for (const n of nodes) adj[n.id] = new Set();
  for (const e of [...tedges, ...xedges]) {
    adj[e.a]?.add(e.b);
    adj[e.b]?.add(e.a);
  }

  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const n of nodes) {
    minX = Math.min(minX, n.cx - n.halfW);
    maxX = Math.max(maxX, n.cx + n.halfW);
    minY = Math.min(minY, n.cy - 40);
    maxY = Math.max(maxY, n.cy + 40);
  }

  return { nodes, byId, tedges, xedges, adj, bounds: { minX, maxX, minY, maxY }, docCount };
}

/* Bézier paths — verbatim from the prototype. */
export function treePath(a: AtlasNode, b: AtlasNode): string {
  const x1 = a.cx + a.halfW, y1 = a.cy, x2 = b.cx - b.halfW, y2 = b.cy;
  const dx = (x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
export function xPath(a: AtlasNode, b: AtlasNode): string {
  const x = Math.max(a.cx + a.halfW, b.cx + b.halfW);
  const y1 = a.cy, y2 = b.cy;
  const bow = 56 + Math.abs(y2 - y1) * 0.32;
  return `M${x},${y1} C${x + bow},${y1} ${x + bow},${y2} ${x},${y2}`;
}
