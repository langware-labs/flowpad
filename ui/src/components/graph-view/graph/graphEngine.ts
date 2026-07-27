import Sigma from 'sigma';
import EdgeCurveProgram from '@sigma/edge-curve';
import { NodePictogramProgram } from '@sigma/node-image';
import dagre from '@dagrejs/dagre';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import Graph from 'graphology';
import { paletteForTheme, type GraphPalette, type Theme } from './themeColors';
import type { GraphLayout } from './loadDepGraph';
import { cameraRatioForVisibleSpan } from './graphCamera';
import { drawGraphNodeHover, drawGraphNodeLabel } from './graphLabels';
import { colorForWorldViewMode } from './heat';
import { applyCircleForestLayout } from './circleLayout';
import { DEFAULT_WORLDVIEW_COLOR_MODE, type WorldViewColorMode } from '@src/types/WorldViewColorMode';
import { nodeDataForGraph, searchGraph, type NodeData, type SearchResult } from './graphModel';
import type { GraphRenderer, LocalState } from './graphRenderer';

const FLICKER_COLOR: Record<'create' | 'update' | 'delete', string> = {
  create: '#22d3ee',
  update: '#facc15',
  delete: '#f87171',
};
const FLICKER_MS = 900;

export type { NodeData } from './graphModel';
export type { LocalState } from './graphRenderer';

export class GraphEngine implements GraphRenderer {
  readonly graph: Graph;
  readonly layout: GraphLayout;
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
  private colorMode: WorldViewColorMode = DEFAULT_WORLDVIEW_COLOR_MODE;

  private listeners = {
    nodeSelect: new Set<(key: string | null) => void>(),
    nodeDoubleClick: new Set<(key: string) => void>(),
  };

  constructor(graph: Graph, layout: GraphLayout = 'force') {
    this.graph = graph;
    this.layout = layout;
    graph.forEachNode((node, attrs) => {
      this.nodeTypeByKey.set(node, (attrs.entityType as string) ?? '');
    });
  }

  init(container: HTMLElement): void {
    if (this.layout === 'dagre') this.applyDagreLayout();
    else if (this.layout === 'circle') applyCircleForestLayout(this.graph);
    else this.applyForceLayout();

    this.sigma = new Sigma(this.graph, container, {
      renderLabels: true,
      renderEdgeLabels: false,
      hideLabelsOnMove: true,
      hideEdgesOnMove: true,
      labelFont: 'Inter, system-ui, sans-serif',
      labelColor: { color: this.palette.labelColor },
      labelSize: 12,
      labelWeight: '500',
      labelDensity: 0.35,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 6,
      defaultDrawNodeLabel: (context, data, settings) => drawGraphNodeLabel(context, data, settings, this.palette),
      defaultDrawNodeHover: (context, data, settings) => drawGraphNodeHover(context, data, settings, this.palette),
      zIndex: true,
      minCameraRatio: null,
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
        res.label = (data.displayLabel as string) || data.label;
        const modeColor = colorForWorldViewMode(data, this.colorMode);
        if (modeColor) res.color = modeColor;
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
          res.forceLabel = true;
        }
        if (this.selectedNode === node) {
          res.zIndex = 20;
          res.size = (data.size as number) * 1.4;
          res.color = this.palette.hoverNodeBorder;
          res.label = data.label;
          res.forceLabel = true;
          res.highlighted = true;
        } else if (this.hoveredNode && !this.isDragging) {
          if (node === this.hoveredNode) {
            res.zIndex = 10;
            res.size = (data.size as number) * 1.25;
            if (this.colorMode !== DEFAULT_WORLDVIEW_COLOR_MODE) {
              res.color = this.palette.hoverNodeBorder;
            }
            res.label = data.label;
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

  private applyForceLayout(): void {
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
  }

  private applyDagreLayout(): void {
    const layoutGraph = new dagre.graphlib.Graph();
    layoutGraph.setGraph({ rankdir: 'TB', ranksep: 90, nodesep: 48, edgesep: 24, marginx: 24, marginy: 24 });
    layoutGraph.setDefaultEdgeLabel(() => ({}));
    this.graph.forEachNode((node) => layoutGraph.setNode(node, { width: 92, height: 56 }));
    this.graph.forEachDirectedEdge((_edge, _attrs, source, target) => layoutGraph.setEdge(source, target));
    dagre.layout(layoutGraph);
    this.graph.forEachNode((node) => {
      const position = layoutGraph.node(node) as { x?: number; y?: number } | undefined;
      if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') return;
      this.graph.setNodeAttribute(node, 'x', position.x);
      // Sigma's graph coordinates are y-up. Flip Dagre's screen-space y so
      // parent resources appear above their children.
      this.graph.setNodeAttribute(node, 'y', -position.y);
    });
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

  /** Recolor reducer output without rebuilding the graph or rerunning layout. */
  setColorMode(mode: WorldViewColorMode): void {
    if (mode === this.colorMode) return;
    this.colorMode = mode;
    this.sigma?.refresh();
  }

  private setupInteractions(container: HTMLElement): void {
    if (!this.sigma) return;

    this.sigma.on('clickNode', ({ node }) => {
      if (this.isDragging) return;
      this.listeners.nodeSelect.forEach((fn) => fn(node));
    });

    this.sigma.on('doubleClickNode', ({ node, event }) => {
      if (this.isDragging) return;
      // Stop sigma's built-in zoom-on-double-click so local mode can manage the camera
      event.preventSigmaDefault();
      this.listeners.nodeDoubleClick.forEach((fn) => fn(node));
    });

    this.sigma.on('clickStage', () => {
      if (this.isDragging) return;
      this.listeners.nodeSelect.forEach((fn) => fn(null));
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

  setHiddenTypes(types: ReadonlySet<string>): void {
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
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    let positionedNodes = 0;
    for (const key of this.localVisible) {
      const d = this.sigma.getNodeDisplayData(key);
      if (!d) continue;
      positionedNodes += 1;
      if (d.x < minX) minX = d.x;
      if (d.x > maxX) maxX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.y > maxY) maxY = d.y;
    }
    if (!isFinite(minX)) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY);
    const ratio = cameraRatioForVisibleSpan(span, positionedNodes);
    void this.sigma.getCamera().animate({ x: cx, y: cy, ratio }, { duration: 500 });
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
      void sig.getCamera().animate({ x: display.x, y: display.y, ratio: 0.3 }, { duration: 500 });
      return true;
    };
    if (!animateTo(this.sigma)) {
      const sig = this.sigma;
      requestAnimationFrame(() => {
        if (this.sigma === sig) animateTo(sig);
      });
    }
  }

  /** Apply URL-derived selection without emitting a second navigation intent. */
  selectNode(key: string | null): void {
    if (key !== null && !this.graph.hasNode(key)) return;
    this.selectedNode = key;
    this.sigma?.refresh();
  }

  resetCamera(): void {
    void this.sigma?.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 500 });
  }

  getNodeData(key: string): NodeData | null {
    return nodeDataForGraph(this.graph, key);
  }

  searchNodes(query: string, limit = 8): SearchResult[] {
    return searchGraph(this.graph, query, limit);
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
