import dagre from '@dagrejs/dagre';

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
  /** Layout direction: TB (default) or LR (default for dynamic). */
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

/** A smooth path through dagre's bend points. */
function pathOf(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    d += ` Q${p.x},${p.y} ${(p.x + q.x) / 2},${(p.y + q.y) / 2}`;
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

export function layoutC4(value: C4Value): C4Layout {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  const dir = value.direction ?? (value.level === 'dynamic' ? 'LR' : 'TB');
  g.setGraph({ rankdir: dir, nodesep: 64, ranksep: 96, edgesep: 24, marginx: 32, marginy: 32 + BOUNDARY_LABEL });
  g.setDefaultEdgeLabel(() => ({}));

  const known = drawnBoundaries(value);
  for (const b of value.boundaries) if (known.has(b.id)) g.setNode(`b:${b.id}`, { label: b.label });
  for (const b of value.boundaries) if (known.has(b.id) && b.parent && known.has(b.parent)) g.setParent(`b:${b.id}`, `b:${b.parent}`);

  const sizes = new Map<string, ReturnType<typeof cardSize>>();
  for (const el of value.elements) {
    const s = cardSize(el);
    sizes.set(el.id, s);
    g.setNode(`e:${el.id}`, { width: CARD_W, height: s.h });
    if (el.boundary && known.has(el.boundary)) g.setParent(`e:${el.id}`, `b:${el.boundary}`);
  }
  const ids = new Set(value.elements.map((e) => e.id));
  const rels = value.relations.filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to);
  for (const r of rels) {
    const text = [r.label, r.tech ? `[${r.tech}]` : ''].filter(Boolean);
    const w = Math.min(200, Math.max(...text.map((t) => t.length * 6.6)) + 16);
    g.setEdge(`e:${r.from}`, `e:${r.to}`, { width: w, height: text.length * 15 + 8, labelpos: 'c' }, r.id);
  }
  dagre.layout(g);

  const cards: C4Card[] = value.elements.map((el) => {
    const n = g.node(`e:${el.id}`);
    const s = sizes.get(el.id)!;
    return {
      el,
      x: n.x - CARD_W / 2,
      y: n.y - s.h / 2,
      w: CARD_W,
      h: s.h,
      top: n.y - s.h / 2 + s.head,
      name: s.name,
      tag: c4Tag(el),
      desc: s.desc,
      slot: c4Slot(el),
    };
  });
  const cardOf = new Map(cards.map((c) => [c.el.id, c]));

  // Boundaries: the box around their cards and inner boxes, padded, with a label band on top.
  const depthOf = (b: C4Boundary, seen = new Set<string>()): number => {
    if (!b.parent || seen.has(b.id)) return 0;
    seen.add(b.id);
    const p = value.boundaries.find((x) => x.id === b.parent);
    return p ? 1 + depthOf(p, seen) : 0;
  };
  const boxOf = new Map<string, C4Box>();
  const byDepth = [...value.boundaries].sort((a, b) => depthOf(b) - depthOf(a));
  for (const b of byDepth) {
    const inner = [
      ...cards.filter((c) => c.el.boundary === b.id),
      ...value.boundaries.filter((x) => x.parent === b.id).map((x) => boxOf.get(x.id)).filter((x): x is C4Box => !!x),
    ];
    if (!inner.length) continue;
    const x0 = Math.min(...inner.map((i) => i.x)) - BOUNDARY_PAD;
    const y0 = Math.min(...inner.map((i) => i.y)) - BOUNDARY_PAD - BOUNDARY_LABEL;
    const x1 = Math.max(...inner.map((i) => i.x + i.w)) + BOUNDARY_PAD;
    const y1 = Math.max(...inner.map((i) => i.y + i.h)) + BOUNDARY_PAD;
    boxOf.set(b.id, { b, x: x0, y: y0, w: x1 - x0, h: y1 - y0, depth: depthOf(b) });
  }
  const boxes = [...boxOf.values()].sort((a, b) => a.depth - b.depth);

  const numbered = value.level === 'dynamic' || rels.some((r) => typeof r.order === 'number');
  const edges: C4Edge[] = rels.map((r, i) => {
    const e = g.edge(`e:${r.from}`, `e:${r.to}`, r.id);
    const from = cardOf.get(r.from)!;
    return {
      r,
      d: pathOf(e.points ?? []),
      lx: e.x ?? 0,
      ly: e.y ?? 0,
      n: numbered ? String(r.order ?? i + 1) : undefined,
      slot: from.slot,
    };
  });

  const all = [...cards, ...boxes];
  const graph = g.graph();
  const width = Math.max(graph.width ?? 0, ...all.map((a) => a.x + a.w + 32));
  const height = Math.max(graph.height ?? 0, ...all.map((a) => a.y + a.h + 32));
  return {
    cards,
    boxes,
    edges,
    width,
    height,
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
  const dir = value.direction ?? (value.level === 'dynamic' ? 'LR' : 'TB');
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
