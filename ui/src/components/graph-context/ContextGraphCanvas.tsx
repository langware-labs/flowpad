import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphContext } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Slider } from '@src/components/ui/slider';
import { cn } from '@src/lib/utils';
import { Minus, Plus } from 'lucide-react';
import { buildContextModel, MAX_NODES, type ContextModel, type ContextNode } from './buildContextModel';
import './context-graph.css';

const MAX_DISTANCE = 5;
const RING = 250; // px between successive distance rings
const NODE_MARGIN = 150; // half-card allowance when fitting to viewport
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface XY {
  x: number;
  y: number;
}

/** Radial tree layout: root at origin, each distance ring at `RING * depth`,
 *  children distributed within their parent's angular slice (sunburst). */
function layout(nodes: ContextNode[]): Map<string, XY> {
  const pos = new Map<string, XY>();
  const range = new Map<string, [number, number]>();
  const root = nodes.find((n) => n.isRoot);
  if (!root) return pos;
  pos.set(root.key, { x: 0, y: 0 });
  range.set(root.key, [0, Math.PI * 2]);

  const byDepth = new Map<number, ContextNode[]>();
  let maxDepth = 0;
  for (const n of nodes) {
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth)!.push(n);
    if (n.depth > maxDepth) maxDepth = n.depth;
  }

  for (let d = 1; d <= maxDepth; d++) {
    const groups = new Map<string, ContextNode[]>();
    for (const n of byDepth.get(d) ?? []) {
      const p = n.parentKey ?? root.key;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(n);
    }
    for (const [p, children] of groups) {
      const [a0, a1] = range.get(p) ?? [0, Math.PI * 2];
      const span = a1 - a0 || Math.PI * 2;
      children.forEach((c, i) => {
        const cs = a0 + (span * i) / children.length;
        const ce = a0 + (span * (i + 1)) / children.length;
        const ang = (cs + ce) / 2;
        const r = RING * d;
        pos.set(c.key, { x: Math.cos(ang) * r, y: Math.sin(ang) * r });
        range.set(c.key, [cs, ce]);
      });
    }
  }
  return pos;
}

/** Quadratic bow between two world points — gentle organic curve. */
function edgePath(a: XY, b: XY): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const k = len * 0.12;
  const cx = mx + (-dy / len) * k;
  const cy = my + (dx / len) * k;
  return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}

/**
 * Atlas-inspired context graph: card nodes, bézier edges, dot-grid paper, full
 * theme-awareness via app tokens. Radial-by-distance layout with pan/zoom.
 */
export default function ContextGraphCanvas({ root }: { root: GraphContext }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [distance, setDistance] = useState(1);
  const [model, setModel] = useState<ContextModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  // User-dragged node positions (world coords), overriding the radial layout.
  const [overrides, setOverrides] = useState<Map<string, XY>>(new Map());

  // Pan/zoom transform of the world layer.
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const m = await buildContextModel(root, distance);
      if (cancelled) return;
      setModel(m);
      setOverrides(new Map()); // fresh layout ⇒ drop manual placements
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root.id, distance]);

  const basePositions = useMemo(
    () => (model ? layout(model.nodes) : new Map<string, XY>()),
    [model],
  );
  // Effective positions = radial layout with any manual drags applied.
  const positions = useMemo(() => {
    if (overrides.size === 0) return basePositions;
    const m = new Map(basePositions);
    for (const [k, v] of overrides) m.set(k, v);
    return m;
  }, [basePositions, overrides]);

  // Refs the window-level drag handlers read without re-subscribing.
  const viewRef = useRef(view);
  viewRef.current = view;
  const basePositionsRef = useRef(basePositions);
  basePositionsRef.current = basePositions;

  // Fit content to the viewport on (re)layout — keyed on the radial base, not
  // on drag overrides, so dragging a node never recentres the whole graph.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || basePositions.size === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of basePositions.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const w = maxX - minX + NODE_MARGIN * 2;
    const h = maxY - minY + NODE_MARGIN * 2;
    const cw = el.clientWidth || 1;
    const ch = el.clientHeight || 1;
    const scale = clamp(Math.min(cw / w, ch / h), MIN_SCALE, 1.3);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setView({ tx: cw / 2 - cx * scale, ty: ch / 2 - cy * scale, scale });
  }, [basePositions]);

  // Wheel zoom around the cursor (native listener so we can preventDefault).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const next = clamp(v.scale * (e.deltaY < 0 ? 1.1 : 0.9), MIN_SCALE, MAX_SCALE);
        const wx = (mx - v.tx) / v.scale;
        const wy = (my - v.ty) / v.scale;
        return { scale: next, tx: mx - wx * next, ty: my - wy * next };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag: background → pan the world; a node (`node` set) → move that node.
  const drag = useRef<{ x: number; y: number; node?: string } | null>(null);
  const [panning, setPanning] = useState(false);
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY };
    setPanning(true);
  }, []);
  // Node grab — starts a per-node drag and stops the background pan from firing.
  const onNodeDown = useCallback((e: React.MouseEvent, key: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = { x: e.clientX, y: e.clientY, node: key };
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.node) {
        const s = viewRef.current.scale || 1;
        const key = d.node;
        setOverrides((prev) => {
          const cur = prev.get(key) ?? basePositionsRef.current.get(key) ?? { x: 0, y: 0 };
          const m = new Map(prev);
          m.set(key, { x: cur.x + dx / s, y: cur.y + dy / s });
          return m;
        });
      } else {
        setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
      }
    };
    const onUp = () => {
      drag.current = null;
      setPanning(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const el = containerRef.current;
    const cw = el?.clientWidth ?? 0;
    const ch = el?.clientHeight ?? 0;
    setView((v) => {
      const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const wx = (cw / 2 - v.tx) / v.scale;
      const wy = (ch / 2 - v.ty) / v.scale;
      return { scale: next, tx: cw / 2 - wx * next, ty: ch / 2 - wy * next };
    });
  }, []);

  // Hover highlight set: the node + its direct neighbors.
  const neighbors = useMemo(() => {
    if (!hover || !model) return null;
    const set = new Set<string>([hover]);
    for (const e of model.edges) {
      if (e.source === hover) set.add(e.target);
      if (e.target === hover) set.add(e.source);
    }
    return set;
  }, [hover, model]);

  const nodeCount = model?.nodes.length ?? 0;

  // Edges + nodes are memoized on their data (not on the pan/zoom `view`), so
  // dragging only restyles the world transform instead of re-running the maps
  // over up to MAX_NODES nodes / edges every mousemove.
  const edgesEl = useMemo(
    () =>
      model?.edges.map((e, i) => {
        const a = positions.get(e.source);
        const b = positions.get(e.target);
        if (!a || !b) return null;
        const hot = !!hover && (e.source === hover || e.target === hover);
        const dim = !!neighbors && !hot;
        return (
          <path
            key={i}
            d={edgePath(a, b)}
            className={cn('ctx-edge', e.kind, e.cross && 'cross', hot && 'hot', dim && 'dim')}
            vectorEffect="non-scaling-stroke"
          />
        );
      }),
    [model, positions, hover, neighbors],
  );

  const nodesEl = useMemo(
    () =>
      model?.nodes.map((n) => {
        const p = positions.get(n.key);
        if (!p) return null;
        const Icon = iconForType(n.type);
        const faded = !!neighbors && !neighbors.has(n.key);
        return (
          <div
            key={n.key}
            className={cn('ctx-node', n.isRoot && 'root', !n.resolved && 'unresolved', faded && 'faded')}
            style={{ left: p.x, top: p.y }}
            onMouseDown={(e) => onNodeDown(e, n.key)}
            onMouseEnter={() => setHover(n.key)}
            onMouseLeave={() => setHover((h) => (h === n.key ? null : h))}
          >
            <div className="ctx-card">
              <span className="ctx-ic">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="ctx-txt">
                <span className="ctx-ttl">{n.label}</span>
                <span className="ctx-kic">{n.type.replace(/_/g, ' ')}</span>
              </span>
            </div>
          </div>
        );
      }),
    [model, positions, neighbors, onNodeDown],
  );

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className={cn('ctx-graph', panning && 'panning')}
        onMouseDown={onMouseDown}
      >
        <div
          className="ctx-world"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
        >
          <svg className="ctx-edges">{edgesEl}</svg>
          {nodesEl}
        </div>

        {/* Chrome */}
        <div className="ctx-chrome">
          <div className="ctx-bar">
            <span className="whitespace-nowrap text-muted-foreground">Distance</span>
            <Slider
              min={1}
              max={MAX_DISTANCE}
              step={1}
              value={[distance]}
              onValueChange={(v) => setDistance(v[0])}
              className="w-36"
              aria-label="Context graph distance"
            />
            <span className="w-4 text-center font-medium tabular-nums text-foreground">{distance}</span>
            <span className="text-muted-foreground">
              {model?.truncated ? `first ${MAX_NODES}` : `${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'}`}
            </span>
          </div>

          <div className="ctx-legend">
            <span className="lr"><span className="sw" style={{ background: 'var(--ctx-member)' }} />Member</span>
            <span className="lr"><span className="sw" style={{ background: 'var(--ctx-shared)' }} />Shared</span>
            <span className="lr"><span className="sw" style={{ background: 'var(--ctx-private)' }} />Private</span>
          </div>

          <div className="ctx-zoom">
            <button type="button" onClick={() => zoomBy(1.2)} title="Zoom in" aria-label="Zoom in">
              <Plus className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => zoomBy(1 / 1.2)} title="Zoom out" aria-label="Zoom out">
              <Minus className="h-4 w-4" />
            </button>
          </div>

          {loading && <div className="ctx-status">Building graph…</div>}
        </div>
      </div>
    </div>
  );
}
