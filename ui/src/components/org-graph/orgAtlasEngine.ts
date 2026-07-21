// Imperative renderer for the org-graph "world" view.
//
// Why not plain React/SVG: the graph can hold thousands of nodes, and mounting
// one DOM node + one SVG path per element (and re-rendering them on every
// pan/zoom) does not scale. Instead this engine draws every edge on a single
// <canvas> with viewport culling, and mounts the rich DOM "cards" ONLY for the
// nodes currently on screen (level-of-detail: dots when zoomed out, cards when
// zoomed in). Cost is O(visible), not O(total). React owns the chrome (zoom
// bar, layout toggle, drawer); this engine owns the canvas + card overlay.
import { treePath, xPath, type AtlasLayout, type AtlasNode } from './orgAtlasData';

const TYPE_COLORS: Record<string, string> = {
  user: '#c084fc',
  group: '#f472b6',
  connection: '#60a5fa',
  workspace: '#34d399',
  page: '#fbbf24',
  task: '#fb923c',
  flow: '#38bdf8',
  flow_message: '#818cf8',
  conversation: '#a3e635',
  fs_item: '#94a3b8',
  compute_node: '#22d3ee',
  reflection: '#e879f9',
  agent: '#f87171',
  knowledge_base: '#2dd4bf',
  organization: '#ffffff',
  team: '#a5b4fc',
  project: '#f0abfc',
  micro_app: '#5eead4',
};
const colorOf = (t: string) => TYPE_COLORS[t] ?? '#8b8b96';

export type LayoutMode = 'radial' | 'tree';

type Pos = Record<string, { x: number; y: number }>;
type EdgePath = (a: AtlasNode, b: AtlasNode) => string;
// A mounted card DOM node carries a back-reference to its graph node.
type CardEl = HTMLDivElement & { _node?: AtlasNode };
const straight: EdgePath = (a, b) => `M${a.cx},${a.cy} L${b.cx},${b.cy}`;

// Concentric radial: root centered, each BFS depth is a ring, a node's angular
// wedge is proportional to how many leaves sit under it, and each ring's radius
// grows to fit its node count — so a big rank spreads around a circle instead of
// stacking into one tall column (which is what the tree layout does).
function radialPositions(layout: AtlasLayout, rootId: string): Pos {
  const children = new Map<string, string[]>();
  for (const e of layout.tedges) {
    if (!children.has(e.a)) children.set(e.a, []);
    children.get(e.a)!.push(e.b);
  }
  const depth = new Map<string, number>([[rootId, 0]]);
  const order: string[] = [rootId];
  for (let i = 0; i < order.length; i++) {
    const cur = order[i];
    for (const ch of children.get(cur) ?? []) {
      if (!depth.has(ch)) {
        depth.set(ch, depth.get(cur)! + 1);
        order.push(ch);
      }
    }
  }
  let maxDepth = 0;
  const countAtDepth: Record<number, number> = {};
  depth.forEach((dp) => {
    maxDepth = Math.max(maxDepth, dp);
    countAtDepth[dp] = (countAtDepth[dp] ?? 0) + 1;
  });
  const leaves = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const ch = children.get(id) ?? [];
    leaves.set(id, ch.length ? ch.reduce((s, c) => s + (leaves.get(c) ?? 1), 0) : 1);
  }
  const MIN_ARC = 150,
    RING_MIN = 360;
  const radius = [0];
  for (let dp = 1; dp <= maxDepth; dp++) {
    const need = ((countAtDepth[dp] ?? 1) * MIN_ARC) / (2 * Math.PI);
    radius[dp] = Math.max(radius[dp - 1] + RING_MIN, need);
  }
  const pos: Pos = {};
  const assign = (id: string, a0: number, a1: number): void => {
    const ang = (a0 + a1) / 2,
      r = radius[depth.get(id) ?? 0] ?? 0;
    pos[id] = { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
    const ch = children.get(id) ?? [];
    if (!ch.length) return;
    const total = ch.reduce((s, c) => s + (leaves.get(c) ?? 1), 0) || 1;
    let cur = a0;
    for (const c of ch) {
      const span = ((a1 - a0) * (leaves.get(c) ?? 1)) / total;
      assign(c, cur, cur + span);
      cur += span;
    }
  };
  assign(rootId, -Math.PI, Math.PI);
  const outR = (radius[maxDepth] ?? RING_MIN) + RING_MIN;
  const orphans = layout.nodes.filter((n) => !depth.has(n.id));
  orphans.forEach((n, i) => {
    const ang = (i / Math.max(1, orphans.length)) * 2 * Math.PI;
    pos[n.id] = { x: Math.cos(ang) * outR, y: Math.sin(ang) * outR };
  });
  return pos;
}

export type EngineOptions = {
  onOpenNode: (id: string) => void;
  onZoom?: (percent: number) => void;
  initialMode?: LayoutMode;
};

export type Engine = {
  setMode: (m: LayoutMode) => void;
  zoomBy: (factor: number) => void;
  fit: () => void;
  setFocus: (id: string | null) => void;
  destroy: () => void;
};

const MIN_ZOOM = 0.0008; // below any layout's fit scale, so you can always zoom out to the whole graph
const MAX_ZOOM = 2.4;
const LOD_CARDS = 0.4; // above this zoom show DOM cards, below show dots
const HEADER_INSET = 92; // reserve top px for the fixed page header when fitting
const NODE_HALF_H = 40; // card half-height, used for both culling and layout bounds

export function createEngine(host: HTMLDivElement, layout: AtlasLayout, opts: EngineOptions): Engine {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  const world = document.createElement('div');
  world.className = 'world';
  host.appendChild(canvas);
  host.appendChild(world);
  const ctx = canvas.getContext('2d')!;
  const DPR = Math.min(2, window.devicePixelRatio || 1);

  const rootId = layout.nodes.find((n) => n.kicker === 'You')?.id ?? layout.nodes[0]?.id ?? '';
  const posTree: Pos = {};
  for (const n of layout.nodes) posTree[n.id] = { x: n.cx, y: n.cy };
  const posRadial = radialPositions(layout, rootId);

  // The one place that knows what differs per layout: positions + edge builders.
  const MODES: Record<LayoutMode, { pos: Pos; edge: EdgePath; xedge: EdgePath }> = {
    radial: { pos: posRadial, edge: straight, xedge: straight },
    tree: { pos: posTree, edge: treePath, xedge: xPath },
  };
  let mode: LayoutMode = opts.initialMode ?? 'radial';
  let focusId: string | null = null;
  let hover: string | null = null;

  // Edges pre-resolved to node objects with a cached Path2D. Edge geometry is
  // world-space, so the path is invariant across pan/zoom (the frequent ops);
  // only a layout switch or a node drag invalidates it.
  type EdgeRec = { a: AtlasNode; b: AtlasNode; path: Path2D | null };
  const resolveEdges = (es: { a: string; b: string }[]): EdgeRec[] => {
    const out: EdgeRec[] = [];
    for (const e of es) {
      const a = layout.byId[e.a],
        b = layout.byId[e.b];
      if (a && b) out.push({ a, b, path: null });
    }
    return out;
  };
  const tEdges = resolveEdges(layout.tedges);
  const xEdges = resolveEdges(layout.xedges);
  const invalidatePaths = () => {
    for (const r of tEdges) r.path = null;
    for (const r of xEdges) r.path = null;
  };
  const pathFor = (r: EdgeRec, kind: 'edge' | 'xedge'): Path2D => (r.path ??= new Path2D(MODES[mode][kind](r.a, r.b)));

  const cam = { s: 1, tx: 0, ty: 0 };
  let rect = host.getBoundingClientRect();

  function applyMode() {
    const P = MODES[mode].pos;
    let minX = 1e9,
      maxX = -1e9,
      minY = 1e9,
      maxY = -1e9;
    for (const n of layout.nodes) {
      const p = P[n.id] ?? { x: 0, y: 0 };
      n.cx = p.x;
      n.cy = p.y;
      minX = Math.min(minX, n.cx - n.halfW);
      maxX = Math.max(maxX, n.cx + n.halfW);
      minY = Math.min(minY, n.cy - NODE_HALF_H);
      maxY = Math.max(maxY, n.cy + NODE_HALF_H);
    }
    layout.bounds = { minX, maxX, minY, maxY };
    invalidatePaths();
  }

  function fit() {
    const b = layout.bounds,
      padX = 80,
      padB = 44;
    const availW = rect.width - padX * 2,
      availH = rect.height - HEADER_INSET - padB;
    const cw = Math.max(1, b.maxX - b.minX),
      ch = Math.max(1, b.maxY - b.minY);
    cam.s = Math.min(availW / cw, availH / ch, 1.1);
    cam.tx = padX + (availW - cw * cam.s) / 2 - b.minX * cam.s;
    cam.ty = HEADER_INSET + (availH - ch * cam.s) / 2 - b.minY * cam.s;
  }

  const toWorldX = (px: number) => (px - cam.tx) / cam.s;
  const toWorldY = (py: number) => (py - cam.ty) / cam.s;

  // hotSet (a node + its neighbors) only changes on hover/focus change, not on pan/zoom.
  let hotKey: string | null | undefined;
  let hotSetCache: Set<string> | null = null;
  function hotSetFor(h: string | null): Set<string> | null {
    if (h !== hotKey) {
      hotKey = h;
      hotSetCache = h ? new Set([h, ...(layout.adj[h] ?? [])]) : null;
    }
    return hotSetCache;
  }

  // DOM card pool: cards are expensive, so reuse detached ones across frames.
  const pool: HTMLDivElement[] = [];
  function acquireCard(): HTMLDivElement & Record<string, any> {
    return (pool.pop() ?? buildCard()) as HTMLDivElement & Record<string, any>;
  }
  function buildCard(): HTMLDivElement {
    const c = document.createElement('div');
    c.innerHTML =
      '<div class="card"><div class="kic"><span class="pip"></span><span class="k-kicker"></span></div>' +
      '<div class="ttl"></div><div class="sub"></div><div class="deg"></div></div>';
    const any = c as any;
    any._kicker = c.querySelector('.k-kicker');
    any._ttl = c.querySelector('.ttl');
    any._sub = c.querySelector('.sub');
    any._deg = c.querySelector('.deg');
    any._kic = c.querySelector('.kic');
    c.addEventListener('mousedown', onCardDown);
    c.addEventListener('click', onCardClick);
    return c;
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(DPR * cam.s, 0, 0, DPR * cam.s, DPR * cam.tx, DPR * cam.ty);
    const m = 140 / cam.s;
    const vx1 = toWorldX(0) - m,
      vy1 = toWorldY(0) - m,
      vx2 = toWorldX(rect.width) + m,
      vy2 = toWorldY(rect.height) + m;
    const inView = (n: AtlasNode) =>
      n.cx + n.halfW >= vx1 && n.cx - n.halfW <= vx2 && n.cy + NODE_HALF_H >= vy1 && n.cy - NODE_HALF_H <= vy2;
    const hotSet = hotSetFor(hover ?? focusId);
    const showCards = cam.s >= LOD_CARDS;

    ctx.setLineDash([2 / cam.s, 4 / cam.s]);
    ctx.strokeStyle = 'rgba(150,150,170,0.14)';
    ctx.lineWidth = 1 / cam.s;
    for (const r of xEdges) {
      if (!inView(r.a) && !inView(r.b)) continue;
      ctx.stroke(pathFor(r, 'xedge'));
    }
    ctx.setLineDash([]);
    for (const r of tEdges) {
      if (!inView(r.a) && !inView(r.b)) continue;
      const isHot = hotSet && hotSet.has(r.a.id) && hotSet.has(r.b.id);
      ctx.strokeStyle = isHot ? 'rgba(147,197,253,0.95)' : hotSet ? 'rgba(120,120,140,0.08)' : 'rgba(129,140,248,0.45)';
      ctx.lineWidth = (isHot ? 2 : 1) / cam.s;
      ctx.stroke(pathFor(r, 'edge'));
    }

    while (world.firstChild) {
      const c = world.firstChild as HTMLDivElement & Record<string, any>;
      world.removeChild(c);
      if (c._ttl) pool.push(c);
    }
    if (showCards) {
      world.style.transform = `translate(${cam.tx}px,${cam.ty}px) scale(${cam.s})`;
      for (const n of layout.nodes) {
        if (!inView(n)) continue;
        const faded = hotSet && !hotSet.has(n.id);
        const active = focusId === n.id || hover === n.id;
        const c = acquireCard();
        c.className = 'node ' + n.type + (active ? ' active' : '') + (faded ? ' faded' : '');
        c.style.left = n.cx + 'px';
        c.style.top = n.cy + 'px';
        c._node = n;
        c._kicker.textContent = n.kicker ?? '';
        c._kic.style.display = n.kicker ? '' : 'none';
        c._ttl.textContent = n.title;
        c._sub.textContent = n.sub ?? '';
        c._sub.style.display = n.sub ? '' : 'none';
        c._deg.textContent = n.deg > 0 ? String(n.deg) : '';
        c._deg.style.display = n.deg > 0 ? '' : 'none';
        world.appendChild(c);
      }
    } else {
      for (const n of layout.nodes) {
        if (!inView(n)) continue;
        ctx.fillStyle = hotSet && !hotSet.has(n.id) ? 'rgba(120,120,130,0.4)' : colorOf(n.entityType);
        ctx.beginPath();
        ctx.arc(n.cx, n.cy, (n.entityType === 'user' ? 7 : 3.4) / cam.s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // onZoom drives a React state update; only fire when the % actually changed
    // (draw runs on every pan/hover/drag frame, but zoom rarely changes).
    const pct = Math.round(cam.s * 100);
    if (pct !== lastZoomPct) {
      lastZoomPct = pct;
      opts.onZoom?.(pct);
    }
  }
  let lastZoomPct = -1;

  function zoomAt(px: number, py: number, factor: number) {
    const ns = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.s * factor));
    const k = ns / cam.s;
    cam.tx = px - (px - cam.tx) * k;
    cam.ty = py - (py - cam.ty) * k;
    cam.s = ns;
    draw();
  }

  // ---- interaction ----
  let panning: { x: number; y: number; tx: number; ty: number } | null = null;
  let drag: { n: AtlasNode; mx: number; my: number; cx: number; cy: number; moved: boolean } | null = null;
  let suppressClick = false;

  function onCardDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const n = (e.currentTarget as any)._node as AtlasNode;
    if (!n) return;
    e.stopPropagation();
    drag = { n, mx: e.clientX, my: e.clientY, cx: n.cx, cy: n.cy, moved: false };
    host.classList.add('panning');
  }
  function onCardClick(e: MouseEvent) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const n = (e.currentTarget as any)._node as AtlasNode;
    if (n) opts.onOpenNode(n.id);
  }
  function onStageDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.node') || t.closest('.chrome') || t.closest('.drawer')) return;
    panning = { x: e.clientX, y: e.clientY, tx: cam.tx, ty: cam.ty };
    host.classList.add('panning');
  }
  function onMove(e: MouseEvent) {
    if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.mx, e.clientY - drag.my) > 4) drag.moved = true;
      drag.n.cx = drag.cx + (e.clientX - drag.mx) / cam.s;
      drag.n.cy = drag.cy + (e.clientY - drag.my) / cam.s;
      invalidatePaths(); // the moved node's incident edges must be rebuilt
      draw();
      return;
    }
    if (panning) {
      cam.tx = panning.tx + (e.clientX - panning.x);
      cam.ty = panning.ty + (e.clientY - panning.y);
      draw();
    }
  }
  function onUp() {
    if (drag) {
      suppressClick = drag.moved;
      drag = null;
    }
    panning = null;
    host.classList.remove('panning');
  }
  function onWheel(e: WheelEvent) {
    if ((e.target as HTMLElement).closest('.chrome') || (e.target as HTMLElement).closest('.drawer')) return;
    e.preventDefault();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1 - e.deltaY * 0.0016);
  }
  function onHostMove(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<CardEl>('.node');
    const id = el?._node?.id ?? null;
    if (id !== hover) {
      hover = id;
      draw();
    }
  }
  function onResize() {
    rect = host.getBoundingClientRect();
    canvas.width = rect.width * DPR;
    canvas.height = rect.height * DPR;
    draw();
  }

  host.addEventListener('mousedown', onStageDown);
  host.addEventListener('mousemove', onHostMove);
  host.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('resize', onResize);

  applyMode();
  onResize(); // sets canvas size + draws
  fit();
  draw();

  return {
    setMode(m: LayoutMode) {
      if (m !== mode) {
        mode = m;
        applyMode();
        fit();
      }
      draw();
    },
    zoomBy(factor: number) {
      zoomAt(rect.width / 2, rect.height / 2, factor);
    },
    fit() {
      fit();
      draw();
    },
    setFocus(id: string | null) {
      focusId = id;
      const n = id ? layout.byId[id] : null;
      if (n) {
        cam.s = Math.max(cam.s, 0.6);
        cam.tx = rect.width / 2 - n.cx * cam.s;
        cam.ty = rect.height / 2 - n.cy * cam.s;
      }
      draw();
    },
    destroy() {
      host.removeEventListener('mousedown', onStageDown);
      host.removeEventListener('mousemove', onHostMove);
      host.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
      canvas.remove();
      world.remove();
    },
  };
}
