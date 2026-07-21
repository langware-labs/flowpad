// Org Atlas — data fetch + canvas layout, adapted from the desktop Knowledge
// Atlas (knowledge-atlas/atlasData.ts). Same left-to-right card tree + bézier
// flows + cross-link web, but the tree is ORGANIZATION → teams → members and
// the edge label is the ROLE the child holds on the parent.
//
// org_graph returns role edges as member → org (member holds a role ON org).
// For the tree we reverse them into parent → child (org → member), so the org
// is the root card and members fan out to the right. A member who belongs to
// several entities gets ONE tree parent (prefer a team, else the org) and a
// dashed cross-link to the others — keeping the layout a clean tree.

import { ActionInfo, dataManager } from '@sdk';

type RawNode = { type: string; id: string; label: string | null; key: string };
type RawEdge = { from: { type: string; id: string }; to: { type: string; id: string }; kind: string };

export type AtlasNode = {
  id: string;
  type: 'root' | 'section' | 'doc'; // org → root, team → section, user → doc-card
  entityType: string; // organization | team | user
  title: string;
  sub: string | null; // role text for members
  kicker: string | null;
  cx: number;
  cy: number;
  halfW: number;
  deg: number; // cross-link degree
};
export type AtlasEdge = { id: string; a: string; b: string; summary?: string };
export type AtlasLayout = {
  nodes: AtlasNode[];
  byId: Record<string, AtlasNode>;
  tedges: AtlasEdge[];
  xedges: AtlasEdge[];
  adj: Record<string, Set<string>>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  counts: Record<string, number>;
};

const YGAP = 96;
const COL_X0 = 40;
const COL_GAP = 360;
const HALF_W = { root: 120, section: 92, doc: 104 };

// A leaf-heavy rank — e.g. the viewer's "star" of dozens of members/assets at a
// single depth — would otherwise stack into one very tall column (height grows
// linearly with the count). When a node's children are ALL leaves and there are
// at least WRAP_MIN of them, lay them out as a compact grid block within their
// depth band: ~√n rows, with the overflow spilling into sub-columns SUBCOL_W
// apart. The rank's height becomes ~√n·YGAP instead of n·YGAP. Everything else —
// the tidy-tree centering, the cards, the bézier edges and the depth columns —
// is unchanged.
const WRAP_MIN = 14;
const SUBCOL_W = 240;

const keyOf = (r: { type: string; id: string }) => `${r.type}-${r.id}`;

export async function fetchOrgGraph(): Promise<{ nodes: RawNode[]; edges: RawEdge[]; viewer: string | null }> {
  const data = await dataManager.callAction<undefined, { nodes?: RawNode[]; edges?: RawEdge[]; viewer?: string }>(
    new ActionInfo('org_graph'),
  );
  return {
    nodes: Array.isArray(data?.nodes) ? data.nodes : [],
    edges: Array.isArray(data?.edges) ? data.edges : [],
    viewer: data?.viewer ?? null,
  };
}

export function buildOrgAtlasLayout(nodesIn: RawNode[], edgesIn: RawEdge[], viewer: string | null): AtlasLayout {
  const inByKey = new Map(nodesIn.map((n) => [n.key, n]));
  const counts: Record<string, number> = { organization: 0, team: 0, user: 0 };
  for (const n of nodesIn) counts[n.type] = (counts[n.type] ?? 0) + 1;

  // Undirected adjacency carrying the role (the role the *member* end holds).
  const adjList = new Map<string, Array<{ other: string; role: string }>>();
  const push = (a: string, b: string, role: string) => {
    (adjList.get(a) ?? adjList.set(a, []).get(a)!).push({ other: b, role });
  };
  for (const e of edgesIn) {
    const m = keyOf(e.from); // member
    const t = keyOf(e.to); // org/team
    if (m === t) continue;
    push(m, t, e.kind);
    push(t, m, e.kind);
  }

  // Root the tree at the viewing user ("your world"); fall back to the first
  // node. BFS assigns each discovered node a single parent + depth, so the data
  // — which is a star around the viewer — always renders as a clean tree.
  const rootKey = viewer && inByKey.has(viewer) ? viewer : (nodesIn[0]?.key ?? null);
  const roleToParent = new Map<string, string>();
  const depthOf = new Map<string, number>();
  const treeChildren = new Map<string, string[]>();
  const treeEdgeSet = new Set<string>();
  if (rootKey) {
    depthOf.set(rootKey, 0);
    const q = [rootKey];
    while (q.length) {
      const cur = q.shift()!;
      for (const { other, role } of adjList.get(cur) ?? []) {
        if (depthOf.has(other)) continue;
        depthOf.set(other, (depthOf.get(cur) ?? 0) + 1);
        roleToParent.set(other, role);
        (treeChildren.get(cur) ?? treeChildren.set(cur, []).get(cur)!).push(other);
        treeEdgeSet.add(cur < other ? `${cur}|${other}` : `${other}|${cur}`);
        q.push(other);
      }
    }
  }

  // Cross-links: every edge not used by the BFS tree.
  const xedges: AtlasEdge[] = [];
  const deg: Record<string, number> = {};
  const xseen = new Set<string>();
  for (const e of edgesIn) {
    const a = keyOf(e.from),
      b = keyOf(e.to);
    if (a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (treeEdgeSet.has(k) || xseen.has(k)) continue;
    xseen.add(k);
    xedges.push({ id: `x:${k}`, a, b });
    deg[a] = (deg[a] ?? 0) + 1;
    deg[b] = (deg[b] ?? 0) + 1;
  }

  const order = (k: string) => {
    const n = inByKey.get(k);
    return `${n?.type === 'organization' ? '0' : n?.type === 'team' ? '1' : '2'}:${n?.label ?? ''}`;
  };
  for (const arr of treeChildren.values()) arr.sort((a, b) => order(a).localeCompare(order(b)));

  const nodes: AtlasNode[] = [];
  const byId: Record<string, AtlasNode> = {};
  const xOffsetOf = new Map<string, number>(); // horizontal spill for grid-wrapped ranks
  const forcedCy = new Map<string, number>(); // pre-assigned row for grid-wrapped leaves
  let row = 0;

  const place = (key: string): number => {
    const src = inByKey.get(key);
    if (!src || byId[key]) return byId[key]?.cy ?? row * YGAP;
    const kids = treeChildren.get(key) ?? [];
    let cy: number;
    if (kids.length === 0) {
      cy = forcedCy.has(key) ? forcedCy.get(key)! : row++ * YGAP;
    } else if (kids.length >= WRAP_MIN && kids.every((k) => (treeChildren.get(k)?.length ?? 0) === 0)) {
      // Large leaf-rank → grid-wrap into a compact block instead of one tall column.
      const rows = Math.ceil(Math.sqrt(kids.length));
      const base = row;
      kids.forEach((k, i) => {
        forcedCy.set(k, (base + (i % rows)) * YGAP);
        xOffsetOf.set(k, Math.floor(i / rows) * SUBCOL_W);
      });
      row = base + rows;
      kids.forEach((k) => place(k)); // create the leaf cards at their forced grid slots
      cy = (base + (rows - 1) / 2) * YGAP;
    } else {
      const ys = kids.map((k) => place(k));
      cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    // Card style by entity type; column by BFS depth. Orgs and teams get the
    // container card styles; EVERY other entity type (users and shared assets
    // alike — skill, project, conversation, …) renders as a generic 'doc' card.
    // The card's kicker/drawer surface ``entityType`` so assets stay
    // distinguishable from people. This is what lets the access-scoped graph
    // render arbitrary reachable entities without a per-type frontend change.
    const t: AtlasNode['type'] = src.type === 'organization' ? 'root' : src.type === 'team' ? 'section' : 'doc';
    const halfW =
      t === 'root' ? HALF_W.root : t === 'section' ? Math.max(60, (src.label ?? '').length * 5 + 30) : HALF_W.doc;
    const depth = depthOf.get(key) ?? 0;
    const node: AtlasNode = {
      id: key,
      type: t,
      entityType: src.type,
      title: src.label || src.type,
      sub: roleToParent.get(key) ?? null,
      kicker: key === rootKey ? 'You' : src.type,
      cx: COL_X0 + depth * COL_GAP + (xOffsetOf.get(key) ?? 0),
      cy,
      halfW,
      deg: deg[key] ?? 0,
    };
    nodes.push(node);
    byId[key] = node;
    return cy;
  };
  if (rootKey) place(rootKey);
  // Any node not reached by BFS (shouldn't happen for connected world data).
  for (const n of nodesIn) if (!byId[n.key]) place(n.key);

  const tedges: AtlasEdge[] = [];
  for (const [p, kids] of treeChildren) {
    if (!byId[p]) continue;
    for (const k of kids) {
      if (!byId[k]) continue;
      tedges.push({ id: `t:${p}>${k}`, a: p, b: k, summary: roleToParent.get(k) });
    }
  }

  const adj: Record<string, Set<string>> = {};
  for (const n of nodes) adj[n.id] = new Set();
  for (const e of [...tedges, ...xedges]) {
    adj[e.a]?.add(e.b);
    adj[e.b]?.add(e.a);
  }

  let minX = 1e9,
    maxX = -1e9,
    minY = 1e9,
    maxY = -1e9;
  for (const n of nodes) {
    minX = Math.min(minX, n.cx - n.halfW);
    maxX = Math.max(maxX, n.cx + n.halfW);
    minY = Math.min(minY, n.cy - 40);
    maxY = Math.max(maxY, n.cy + 40);
  }
  if (nodes.length === 0) {
    minX = maxX = minY = maxY = 0;
  }

  return { nodes, byId, tedges, xedges, adj, bounds: { minX, maxX, minY, maxY }, counts };
}

/* Bézier paths — verbatim from the Knowledge Atlas. */
export function treePath(a: AtlasNode, b: AtlasNode): string {
  const x1 = a.cx + a.halfW,
    y1 = a.cy,
    x2 = b.cx - b.halfW,
    y2 = b.cy;
  const dx = (x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
export function xPath(a: AtlasNode, b: AtlasNode): string {
  const x = Math.max(a.cx + a.halfW, b.cx + b.halfW);
  const y1 = a.cy,
    y2 = b.cy;
  const bow = 56 + Math.abs(y2 - y1) * 0.32;
  return `M${x},${y1} C${x + bow},${y1} ${x + bow},${y2} ${x},${y2}`;
}
