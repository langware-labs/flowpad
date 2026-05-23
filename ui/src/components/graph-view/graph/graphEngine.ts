import Sigma from 'sigma';
import EdgeCurveProgram from '@sigma/edge-curve';
import { NodePictogramProgram } from '@sigma/node-image';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import Graph from 'graphology';
import { hexForType } from '../ui/typeColors';
import { paletteForTheme, type GraphPalette, type Theme } from './themeColors';

const FLICKER_COLOR: Record<'create' | 'update' | 'delete', string> = {
  create: '#22d3ee',
  update: '#facc15',
  delete: '#f87171',
};
const FLICKER_MS = 900;

export type NodeData = {
  key: string;
  type: string;
  id: string;
  label: string;
  isGhost: boolean;
  community: number;
  color: string;
  degree: number;
  neighbors: Array<{
    key: string;
    type: string;
    label: string;
    edgeKind: string;
  }>;
  edgeCounts: Record<string, number>;
};

export type LocalState = {
  root: string | null;
  depth: number;
  visibleCount: number;
};

export class GraphEngine {
  readonly graph: Graph;
  private sigma: Sigma | null = null;

  private hoveredNode: string | null = null;
  private hoverNeighbors = new Set<string>();
  private selectedNode: string | null = null;
  private hiddenTypes = new Set<string>();
  private localRoot: string | null = null;
  private localDepth: number = 1;
  private localVisible = new Set<string>();
  private nodeTypeByKey = new Map<string, string>();
  private flickers = new Map<string, { op: 'create' | 'update' | 'delete'; timer: number }>();
  private draggedNode: string | null = null;
  private isDragging = false;
  private palette: GraphPalette = paletteForTheme('dark');

  private listeners = {
    nodeSelect: new Set<(key: string | null) => void>(),
    nodeDoubleClick: new Set<(key: string) => void>(),
  };

  constructor(graph: Graph) {
    this.graph = graph;
    graph.forEachNode((node, attrs) => {
      this.nodeTypeByKey.set(node, (attrs.entityType as string) ?? '');
    });
  }

  init(container: HTMLElement): void {
    const order = this.graph.order;
    const iterations = Math.min(220, Math.max(60, Math.round(2200 / Math.max(1, order))));
    forceAtlas2.assign(this.graph, {
      iterations,
      settings: {
        gravity: 1.4,
        scalingRatio: 9,
        strongGravityMode: false,
        slowDown: 5,
        barnesHutOptimize: order > 200,
        barnesHutTheta: 0.7,
      },
    });

    this.sigma = new Sigma(this.graph, container, {
      renderLabels: true,
      renderEdgeLabels: false,
      labelFont: 'Inter, system-ui, sans-serif',
      labelColor: { color: this.palette.labelColor },
      labelSize: 11,
      labelDensity: 0.6,
      labelRenderedSizeThreshold: 8,
      zIndex: true,
      minCameraRatio: 0.05,
      maxCameraRatio: 15,
      defaultNodeColor: this.palette.defaultNodeColor,
      defaultEdgeColor: this.palette.defaultEdgeColor,
      defaultNodeType: 'image',
      defaultEdgeType: 'curve',
      nodeProgramClasses: {
        image: NodePictogramProgram,
      },
      edgeProgramClasses: {
        curve: EdgeCurveProgram,
      },
      stagePadding: 40,
      nodeReducer: (node, data) => {
        const res = { ...data };
        if (this.hiddenTypes.has(data.entityType as string)) {
          res.hidden = true;
          return res;
        }
        if (this.localRoot && !this.localVisible.has(node)) {
          res.hidden = true;
          return res;
        }
        if (this.localRoot === node) {
          res.zIndex = 25;
          res.size = (data.size as number) * 1.5;
        }
        if (this.selectedNode === node) {
          res.zIndex = 20;
          res.size = (data.size as number) * 1.4;
          res.color = '#ffffff';
        } else if (this.hoveredNode && !this.isDragging) {
          if (node === this.hoveredNode) {
            res.zIndex = 10;
            res.size = (data.size as number) * 1.25;
          } else if (this.hoverNeighbors.has(node)) {
            res.zIndex = 5;
          } else {
            res.color = 'rgba(148, 163, 184, 0.25)';
            res.label = '';
          }
        }
        if (data.isGhost as boolean) {
          res.color = '#475569';
        }
        const flicker = this.flickers.get(node);
        if (flicker) {
          res.color = FLICKER_COLOR[flicker.op];
          res.size = (data.size as number) * 2.2;
          res.zIndex = 30;
        }
        return res;
      },
      edgeReducer: (edge, data) => {
        const res = { ...data };
        const src = this.graph.source(edge);
        const tgt = this.graph.target(edge);
        const srcType = this.nodeTypeByKey.get(src) ?? '';
        const tgtType = this.nodeTypeByKey.get(tgt) ?? '';
        if (this.hiddenTypes.has(srcType) || this.hiddenTypes.has(tgtType)) {
          res.hidden = true;
          return res;
        }
        if (this.localRoot && (!this.localVisible.has(src) || !this.localVisible.has(tgt))) {
          res.hidden = true;
          return res;
        }
        // Color is theme-aware: stored attributes carry the dark-palette default;
        // re-pick from current palette so edges flip live on theme change.
        const kind = data.kind as keyof GraphPalette['edgeKindColor'] | undefined;
        if (kind && this.palette.edgeKindColor[kind]) {
          res.color = this.palette.edgeKindColor[kind];
        }
        if (this.hoveredNode && !this.isDragging) {
          if (src === this.hoveredNode || tgt === this.hoveredNode) {
            res.color = this.palette.hoverEdgeColor;
            res.size = this.palette.hoverEdgeSize;
            res.zIndex = 5;
          } else {
            res.color = this.palette.dimEdgeColor;
          }
        }
        return res;
      },
    });

    this.setupInteractions(container);
  }

  /** Re-applies theme-aware colors to sigma without rebuilding the layout. */
  setTheme(theme: Theme): void {
    this.palette = paletteForTheme(theme);
    if (!this.sigma) return;
    this.sigma.setSetting('labelColor', { color: this.palette.labelColor });
    this.sigma.setSetting('defaultNodeColor', this.palette.defaultNodeColor);
    this.sigma.setSetting('defaultEdgeColor', this.palette.defaultEdgeColor);
    this.sigma.refresh();
  }

  private setupInteractions(container: HTMLElement): void {
    if (!this.sigma) return;

    this.sigma.on('clickNode', ({ node }) => {
      if (this.isDragging) return;
      this.selectedNode = node;
      this.listeners.nodeSelect.forEach((fn) => fn(node));
      this.sigma?.refresh();
    });

    this.sigma.on('doubleClickNode', ({ node, event }) => {
      if (this.isDragging) return;
      // Stop sigma's built-in zoom-on-double-click so local mode can manage the camera
      event.preventSigmaDefault();
      this.listeners.nodeDoubleClick.forEach((fn) => fn(node));
    });

    this.sigma.on('doubleClickStage', ({ event }) => {
      event.preventSigmaDefault();
    });

    this.sigma.on('clickStage', () => {
      if (this.isDragging) return;
      this.selectedNode = null;
      this.listeners.nodeSelect.forEach((fn) => fn(null));
      this.sigma?.refresh();
    });

    this.sigma.on('enterNode', ({ node }) => {
      if (this.draggedNode) return;
      this.hoveredNode = node;
      this.hoverNeighbors = new Set(this.graph.neighbors(node));
      container.style.cursor = 'pointer';
      this.sigma?.refresh();
    });

    this.sigma.on('leaveNode', () => {
      if (this.draggedNode) return;
      this.hoveredNode = null;
      this.hoverNeighbors.clear();
      container.style.cursor = 'default';
      this.sigma?.refresh();
    });

    this.sigma.on('downNode', ({ node, event }) => {
      this.draggedNode = node;
      this.isDragging = false;
      this.sigma?.getCamera().disable();
      container.style.cursor = 'grabbing';
      event.original.preventDefault();
      event.original.stopPropagation();
    });

    let dragMoved = false;
    this.sigma.getMouseCaptor().on('mousemovebody', (event) => {
      if (!this.draggedNode || !this.sigma) return;
      dragMoved = true;
      this.isDragging = true;
      const pos = this.sigma.viewportToGraph(event);
      this.graph.setNodeAttribute(this.draggedNode, 'x', pos.x);
      this.graph.setNodeAttribute(this.draggedNode, 'y', pos.y);
    });

    const handleUp = () => {
      if (this.draggedNode) {
        this.draggedNode = null;
        this.sigma?.getCamera().enable();
        container.style.cursor = 'default';
        if (dragMoved) {
          setTimeout(() => {
            this.isDragging = false;
            dragMoved = false;
          }, 50);
        } else {
          this.isDragging = false;
        }
      }
    };
    this.sigma.getMouseCaptor().on('mouseup', handleUp);
    this.sigma.getMouseCaptor().on('mouseleave', handleUp);
  }

  setHiddenTypes(types: Set<string>): void {
    this.hiddenTypes = new Set(types);
    this.sigma?.refresh();
  }

  setLocalMode(root: string | null, depth: number = 1): LocalState {
    const nextRoot = root && this.graph.hasNode(root) ? root : null;
    if (nextRoot === this.localRoot && depth === this.localDepth) {
      return this.getLocalState();
    }
    this.localRoot = nextRoot;
    this.localDepth = depth;
    this.localVisible.clear();
    if (this.localRoot) {
      this.localVisible.add(this.localRoot);
      let frontier: string[] = [this.localRoot];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const node of frontier) {
          this.graph.forEachNeighbor(node, (n) => {
            if (!this.localVisible.has(n)) {
              this.localVisible.add(n);
              next.push(n);
            }
          });
        }
        if (next.length === 0) break;
        frontier = next;
      }
    }
    this.sigma?.refresh();
    if (this.localRoot) this.fitVisibleToCamera();
    else this.resetCamera();
    return this.getLocalState();
  }

  getLocalState(): LocalState {
    return {
      root: this.localRoot,
      depth: this.localDepth,
      visibleCount: this.localVisible.size,
    };
  }

  private fitVisibleToCamera(): void {
    if (!this.sigma || this.localVisible.size === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const key of this.localVisible) {
      const d = this.sigma.getNodeDisplayData(key);
      if (!d) continue;
      if (d.x < minX) minX = d.x;
      if (d.x > maxX) maxX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.y > maxY) maxY = d.y;
    }
    if (!isFinite(minX)) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY, 0.05);
    const ratio = Math.max(0.12, span * 1.4);
    this.sigma.getCamera().animate({ x: cx, y: cy, ratio }, { duration: 500 });
  }

  focusNode(key: string): void {
    if (!this.graph.hasNode(key) || !this.sigma) return;
    this.selectedNode = key;
    this.listeners.nodeSelect.forEach((fn) => fn(key));
    this.sigma.refresh();
    // Display data is populated by sigma's first process() pass — when focusNode
    // is invoked immediately after init() (deep-link with ?selected=), the pass
    // hasn't run yet and the camera animate silently no-ops. Force a process
    // synchronously and, if display is still missing, retry on the next frame
    // when sigma's internal layout has settled.
    const animateTo = (sig: Sigma) => {
      const display = sig.getNodeDisplayData(key);
      if (!display) return false;
      sig.getCamera().animate({ x: display.x, y: display.y, ratio: 0.3 }, { duration: 500 });
      return true;
    };
    if (!animateTo(this.sigma)) {
      const sig = this.sigma;
      requestAnimationFrame(() => {
        if (this.sigma === sig) animateTo(sig);
      });
    }
  }

  selectNode(key: string | null): void {
    if (key !== null && !this.graph.hasNode(key)) return;
    this.selectedNode = key;
    this.listeners.nodeSelect.forEach((fn) => fn(key));
    this.sigma?.refresh();
  }

  resetCamera(): void {
    this.sigma?.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 500 });
  }

  getNodeData(key: string): NodeData | null {
    if (!this.graph.hasNode(key)) return null;
    const attrs = this.graph.getNodeAttributes(key);
    const edgeCounts: Record<string, number> = {};
    const neighbors: NodeData['neighbors'] = [];
    this.graph.forEachEdge(key, (_edge, edgeAttrs, source, target) => {
      const kind = (edgeAttrs.kind as string) ?? 'unknown';
      edgeCounts[kind] = (edgeCounts[kind] ?? 0) + 1;
      const other = source === key ? target : source;
      if (neighbors.length < 30) {
        neighbors.push({
          key: other,
          type: this.graph.getNodeAttribute(other, 'entityType') as string,
          label: this.graph.getNodeAttribute(other, 'label') as string,
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
      color: (attrs.color as string) ?? hexForType(attrs.entityType as string),
      degree: this.graph.degree(key),
      neighbors,
      edgeCounts,
    };
  }

  searchNodes(query: string, limit = 8): Array<{ key: string; label: string; type: string; id: string }> {
    if (!query) return [];
    const q = query.toLowerCase();
    const results: Array<{ key: string; label: string; type: string; id: string; score: number }> = [];
    this.graph.forEachNode((node, attrs) => {
      const label = ((attrs.label as string) ?? '').toLowerCase();
      const id = ((attrs.entityId as string) ?? '').toLowerCase();
      let score = -1;
      if (label === q) score = 0;
      else if (label.startsWith(q)) score = 1;
      else if (label.includes(q)) score = 2;
      else if (id.startsWith(q)) score = 3;
      else if (id.includes(q)) score = 4;
      if (score >= 0) {
        results.push({
          key: node,
          label: attrs.label as string,
          type: attrs.entityType as string,
          id: attrs.entityId as string,
          score,
        });
      }
    });
    results.sort((a, b) => a.score - b.score || a.label.length - b.label.length);
    return results.slice(0, limit).map(({ score: _s, ...rest }) => rest);
  }

  onNodeSelect(fn: (key: string | null) => void): () => void {
    this.listeners.nodeSelect.add(fn);
    return () => {
      this.listeners.nodeSelect.delete(fn);
    };
  }

  onNodeDoubleClick(fn: (key: string) => void): () => void {
    this.listeners.nodeDoubleClick.add(fn);
    return () => {
      this.listeners.nodeDoubleClick.delete(fn);
    };
  }

  flickerNode(key: string, op: 'create' | 'update' | 'delete'): void {
    if (!this.graph.hasNode(key)) return;
    const existing = this.flickers.get(key);
    if (existing) window.clearTimeout(existing.timer);
    const timer = window.setTimeout(() => {
      this.flickers.delete(key);
      this.sigma?.refresh();
    }, FLICKER_MS);
    this.flickers.set(key, { op, timer });
    this.sigma?.refresh();
  }

  destroy(): void {
    this.sigma?.kill();
    this.sigma = null;
    this.listeners.nodeSelect.clear();
    this.listeners.nodeDoubleClick.clear();
    this.hoverNeighbors.clear();
    this.localVisible.clear();
    this.nodeTypeByKey.clear();
    for (const { timer } of this.flickers.values()) window.clearTimeout(timer);
    this.flickers.clear();
  }
}
