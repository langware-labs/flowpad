import ELK from 'elkjs/lib/elk.bundled.js';

/**
 * A `c4` chart's value (chartit.c4, the chart's c4.json) and its pure helpers: parse, lay out,
 * and render as Mermaid. The view draws only what `layoutC4` returns, so the look is fixed here.
 */

export const C4_LEVELS = ['landscape', 'context', 'container', 'component', 'code', 'dynamic', 'deployment'] as const;
export const C4_KINDS = ['person', 'system', 'container', 'database', 'queue', 'component', 'code'] as const;
export type C4Level = (typeof C4_LEVELS)[number];
export type C4Kind = (typeof C4_KINDS)[number];
export type C4Status = 'current' | 'migrating' | 'target';

export interface C4Element {
  id: string;
  kind: C4Kind;
  label: string;
  tech?: string;
  description?: string;
  external?: boolean;
  /** The boundary this element sits in. */
  boundary?: string;
  icon?: string;
  /** Another chart (by name) that zooms into this element: drawn as "Open ↗". */
  ref?: string;
  status?: C4Status;
  note?: string;
}

export interface C4Boundary {
  id: string;
  label: string;
  /** system, container, zone, deployment, tenant, team, group — shown as the boundary's tag. */
  kind?: string;
  tech?: string;
  /** The boundary this one sits in. */
  parent?: string;
  note?: string;
}

export interface C4Relation {
  id: string;
  from: string;
  to: string;
  label: string;
  tech?: string;
  /** Step number on a dynamic chart. */
  order?: number;
  /** sync (solid, default) or async (dashed). */
  style?: 'sync' | 'async';
  note?: string;
}

export interface C4Value {
  title?: string;
  level: C4Level;
  /** Layout direction: LR (default — charts read across a wide screen) or TB. */
  direction?: 'TB' | 'LR';
  elements: C4Element[];
  boundaries: C4Boundary[];
  relations: C4Relation[];
}

const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : []);

/** c4.json text → a value; anything unreadable becomes an empty context chart. */
export function parseC4(raw: string | null | undefined): C4Value {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  const level = C4_LEVELS.includes(data.level as C4Level) ? (data.level as C4Level) : 'context';
  return {
    title: typeof data.title === 'string' ? data.title : undefined,
    level,
    direction: data.direction === 'LR' || data.direction === 'TB' ? data.direction : undefined,
    elements: asList<C4Element>(data.elements).map((e) => ({
      ...e,
      kind: C4_KINDS.includes(e.kind) ? e.kind : 'system',
      label: String(e.label ?? e.id ?? ''),
    })),
    boundaries: asList<C4Boundary>(data.boundaries),
    relations: asList<C4Relation>(data.relations),
  };
}

/** The colour slot a kind is drawn in. Identity by kind, never cycled; external is neutral. */
export function c4Slot(el: Pick<C4Element, 'kind' | 'external'>): string {
  if (el.external) return '--s-other';
  if (el.kind === 'person') return '--s4';
  if (el.kind === 'database' || el.kind === 'queue') return '--s3';
  return '--s1';
}

/** The tag line under a name: "Container · FastAPI", "External system". */
export function c4Tag(el: C4Element): string {
  const kind = { person: 'Person', system: 'System', container: 'Container', database: 'Database',
    queue: 'Queue', component: 'Component', code: 'Code' }[el.kind];
  const head = el.external ? `External ${kind.toLowerCase()}` : kind;
  return el.tech ? `${head} · ${el.tech}` : head;
}

// ── layout ─────────────────────────────────────────────────────────────────────

export const CARD_W = 216;
const NAME_LINE = 17;
const TAG_LINE = 15;
const DESC_LINE = 15;
const PAD = 14;
const PERSON_HEAD = 22;
const DESC_CHARS = 31;
const BOUNDARY_PAD = 18;
const BOUNDARY_LABEL = 30;

/** Word-wrap to at most `lines` lines of `chars` characters; the last line ends in "…" when cut. */
export function wrap(text: string, chars: number, lines: number): string[] {
  const out: string[] = [];
  let cur = '';
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= chars) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    cur = w.length > chars ? `${w.slice(0, chars - 1)}…` : w;
    if (out.length === lines) {
      out[lines - 1] = `${out[lines - 1].slice(0, chars - 1)}…`;
      return out;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = `${out[lines - 1].slice(0, chars - 1)}…`;
  }
  return out;
}

export interface C4Card {
  el: C4Element;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the card body starts (below a person's head). */
  top: number;
  name: string[];
  tag: string;
  desc: string[];
  slot: string;
}

export interface C4Box {
  b: C4Boundary;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface C4Edge {
  r: C4Relation;
  d: string;
  lx: number;
  ly: number;
  /** The step number shown on the arrow (dynamic charts, or a relation with `order`). */
  n?: string;
  slot: string;
}

export interface C4Layout {
  cards: C4Card[];
  boxes: C4Box[];
  edges: C4Edge[];
  width: number;
  height: number;
  cardOf: Map<string, C4Card>;
  boxOf: Map<string, C4Box>;
  edgeOf: Map<string, C4Edge>;
}

function cardSize(el: C4Element) {
  const name = wrap(el.label, 24, 2);
  const desc = el.description ? wrap(el.description, DESC_CHARS, 3) : [];
  const head = el.kind === 'person' ? PERSON_HEAD : 0;
  const body = PAD + name.length * NAME_LINE + TAG_LINE + (desc.length ? 6 + desc.length * DESC_LINE : 0) + PAD;
  const extra = el.ref || el.status ? 22 : 0;
  return { name, desc, head, h: head + body + extra };
}

/** An orthogonal route with softly rounded corners. */
function pathOf(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  const R = 8;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(R, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2);
    const ux = Math.sign(c.x - p.x), uy = Math.sign(c.y - p.y), vx = Math.sign(n.x - c.x), vy = Math.sign(n.y - c.y);
    d += ` L${c.x - ux * r},${c.y - uy * r} Q${c.x},${c.y} ${c.x + vx * r},${c.y + vy * r}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/** The boundaries that hold an element, directly or through an inner boundary: the only ones drawn. */
export function drawnBoundaries(value: C4Value): Set<string> {
  const ids = new Set(value.boundaries.map((b) => b.id));
  const drawn = new Set<string>();
  for (const el of value.elements) {
    let at = el.boundary;
    while (at && ids.has(at) && !drawn.has(at)) {
      drawn.add(at);
      at = value.boundaries.find((b) => b.id === at)?.parent;
    }
  }
  return drawn;
}

const elk = new ELK();

interface ElkShape {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkShape[];
  edges?: ElkOut[];
}
interface ElkOut {
  id: string;
  container?: string;
  sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[];
  labels?: { x?: number; y?: number; width: number; height: number }[];
}

/**
 * Lay the chart out with ELK's layered algorithm. Boundaries are real nested nodes with their own
 * padding (a label band on top), so groups never overlap; edge labels get their own space.
 */
export async function layoutC4(value: C4Value): Promise<C4Layout> {
  const known = drawnBoundaries(value);
  const sizes = new Map(value.elements.map((el) => [el.id, cardSize(el)]));
  const ids = new Set(value.elements.map((e) => e.id));
  const rels = value.relations.filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to);

  const nodeOf = (el: C4Element) => ({ id: `e:${el.id}`, width: CARD_W, height: sizes.get(el.id)!.h });
  const boundaryOf = (b: C4Boundary): Record<string, unknown> => ({
    id: `b:${b.id}`,
    layoutOptions: {
      'elk.padding': `[top=${BOUNDARY_PAD + BOUNDARY_LABEL},left=${BOUNDARY_PAD},bottom=${BOUNDARY_PAD},right=${BOUNDARY_PAD}]`,
    },
    children: [
      ...value.elements.filter((e) => e.boundary === b.id).map(nodeOf),
      ...value.boundaries.filter((x) => x.parent === b.id && known.has(x.id)).map(boundaryOf),
    ],
  });
  const top = value.elements.filter((e) => !e.boundary || !known.has(e.boundary)).map(nodeOf);
  const topBoxes = value.boundaries
    .filter((b) => known.has(b.id) && !(b.parent && known.has(b.parent)))
    .map(boundaryOf);

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': (value.direction ?? 'LR') === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '14',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
    },
    children: [...top, ...topBoxes],
    edges: rels.map((r) => {
      const text = [r.label, r.tech ? `[${r.tech}]` : ''].filter(Boolean);
      return {
        id: `r:${r.id}`,
        sources: [`e:${r.from}`],
        targets: [`e:${r.to}`],
        labels: [{ text: r.label, width: Math.min(220, Math.max(...text.map((t) => t.length * 6.4)) + 14), height: text.length * 15 + 6 }],
      };
    }),
  };
  const out = (await elk.layout(graph as never)) as unknown as ElkShape;

  // ELK gives each node relative to its parent: walk down adding offsets.
  const abs = new Map<string, { x: number; y: number; w: number; h: number; depth: number }>();
  const edgesOut: ElkOut[] = [];
  const walk = (n: ElkShape, ox: number, oy: number, depth: number) => {
    const x = ox + (n.x ?? 0);
    const y = oy + (n.y ?? 0);
    abs.set(n.id, { x, y, w: n.width ?? 0, h: n.height ?? 0, depth });
    for (const c of n.children ?? []) walk(c, x, y, depth + 1);
    for (const e of n.edges ?? []) edgesOut.push(e);
  };
  walk(out, 0, 0, -1);

  const cards: C4Card[] = value.elements.map((el) => {
    const n = abs.get(`e:${el.id}`)!;
    const s = sizes.get(el.id)!;
    return {
      el, x: n.x, y: n.y, w: CARD_W, h: s.h, top: n.y + s.head,
      name: s.name, tag: c4Tag(el), desc: s.desc, slot: c4Slot(el),
    };
  });
  const cardOf = new Map(cards.map((c) => [c.el.id, c]));
  const boxes: C4Box[] = value.boundaries
    .filter((b) => known.has(b.id))
    .map((b) => {
      const n = abs.get(`b:${b.id}`)!;
      return { b, x: n.x, y: n.y, w: n.w, h: n.h, depth: n.depth };
    })
    .sort((a, b) => a.depth - b.depth);
  const boxOf = new Map(boxes.map((x) => [x.b.id, x]));

  const numbered = value.level === 'dynamic' || rels.some((r) => typeof r.order === 'number');
  const outOf = new Map(edgesOut.map((e) => [e.id, e]));
  const edges: C4Edge[] = rels.map((r, i) => {
    const e = outOf.get(`r:${r.id}`);
    // An edge's points are relative to its container (the lowest node holding both ends).
    const o = abs.get(e?.container ?? 'root') ?? { x: 0, y: 0 };
    const sec = e?.sections?.[0];
    const pts = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x + o.x, y: p.y + o.y })) : [];
    const lab = e?.labels?.[0];
    const mid = pts[Math.floor(pts.length / 2)] ?? { x: 0, y: 0 };
    return {
      r,
      d: pathOf(pts),
      lx: lab?.x !== undefined ? lab.x + o.x + lab.width / 2 : mid.x,
      ly: lab?.y !== undefined ? lab.y + o.y + lab.height / 2 : mid.y,
      n: numbered ? String(r.order ?? i + 1) : undefined,
      slot: cardOf.get(r.from)!.slot,
    };
  });

  return {
    cards,
    boxes,
    edges,
    width: Math.ceil(out.width ?? 0),
    height: Math.ceil(out.height ?? 0),
    cardOf,
    boxOf,
    edgeOf: new Map(edges.map((e) => [e.r.id, e])),
  };
}

// ── mermaid ────────────────────────────────────────────────────────────────────

const mid = (v: string) => v.replace(/[^A-Za-z0-9_]/g, '_');
const mtext = (v: string) => v.replace(/"/g, "'").replace(/[;#\n]/g, ' ').trim();

/**
 * The chart as a Mermaid `flowchart` (subgraphs for boundaries) — CHART.md's agent-readable copy,
 * and what "Convert to Excalidraw" draws from. A flowchart, not Mermaid's C4 syntax, so it
 * converts and renders everywhere.
 */
export function c4ToMermaid(value: C4Value): string {
  const dir = value.direction ?? 'LR';
  const lines: string[] = [`flowchart ${dir}`];
  const node = (el: C4Element) => {
    const text = `"${mtext(el.label)}<br/>[${mtext(c4Tag(el))}]"`;
    const id = mid(el.id);
    if (el.kind === 'person') return `${id}([${text}])`;
    if (el.kind === 'database') return `${id}[(${text})]`;
    if (el.kind === 'queue') return `${id}[[${text}]]`;
    return `${id}[${text}]`;
  };
  const known = drawnBoundaries(value);
  const emit = (parent: string | undefined, indent: string) => {
    for (const el of value.elements) {
      const at = el.boundary && known.has(el.boundary) ? el.boundary : undefined;
      if (at === parent) lines.push(`${indent}${node(el)}`);
    }
    for (const b of value.boundaries) {
      const at = b.parent && known.has(b.parent) ? b.parent : undefined;
      if (at !== parent || !known.has(b.id)) continue;
      lines.push(`${indent}subgraph ${mid(`b_${b.id}`)}["${mtext(b.label)}${b.kind ? ` [${mtext(b.kind)}]` : ''}"]`);
      emit(b.id, `${indent}  `);
      lines.push(`${indent}end`);
    }
  };
  emit(undefined, '  ');
  const ids = new Set(value.elements.map((e) => e.id));
  value.relations.forEach((r, i) => {
    if (!ids.has(r.from) || !ids.has(r.to)) return;
    const n = value.level === 'dynamic' || typeof r.order === 'number' ? `${r.order ?? i + 1}. ` : '';
    const label = mtext(`${n}${r.label}${r.tech ? ` [${r.tech}]` : ''}`);
    const arrow = r.style === 'async' ? '-.->' : '-->';
    lines.push(`  ${mid(r.from)} ${arrow}|"${label}"| ${mid(r.to)}`);
  });
  const external = value.elements.filter((e) => e.external).map((e) => mid(e.id));
  if (external.length) {
    lines.push('  classDef external fill:#eeeeee,stroke:#999999,color:#333333');
    lines.push(`  class ${external.join(',')} external`);
  }
  return `${lines.join('\n')}\n`;
}
