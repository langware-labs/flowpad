import type Graph from 'graphology';
import { nodeDataForGraph, searchGraph, type NodeData, type SearchResult } from './graphModel';
import type { GraphRenderer, LocalState } from './graphRenderer';
import { buildAtlasLayout, type AtlasLayout, type AtlasMode, type AtlasNode } from './atlasLayout';
import type { Theme } from './themeColors';

const CARD_ZOOM = 0.42;
const PADDING = 120;

export class AtlasGraphRenderer implements GraphRenderer {
  private readonly graph: Graph;
  private readonly layout: AtlasLayout;
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private world: HTMLDivElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private mode: AtlasMode = 'radial';
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private hidden = new Set<string>();
  private localVisible = new Set<string>();
  private localRoot: string | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private cardPool: HTMLButtonElement[] = [];
  private visibleCards = new Set<HTMLButtonElement>();
  private listeners = { select: new Set<(key: string | null) => void>(), doubleClick: new Set<(key: string) => void>() };
  private resizeHandler = () => this.resize();
  private startPanHandler = (event: MouseEvent) => this.startPan(event);
  private hoverHandler = (event: MouseEvent) => this.hover(event);
  private zoomHandler = (event: WheelEvent) => this.zoom(event);
  private moveHandler = (event: MouseEvent) => this.move(event);
  private upHandler = () => this.endPan();
  private panning: { x: number; y: number; tx: number; ty: number } | null = null;
  // Node drag (parity with the Sigma renderer). `moved` gates the click that
  // browsers fire after a drag so dragging never counts as a selection.
  private dragging: { key: string; pointerX: number; pointerY: number; originX: number; originY: number } | null = null;
  private dragMoved = false;
  private theme: Theme = 'dark';

  constructor(graph: Graph, mode: AtlasMode = 'radial') {
    this.graph = graph;
    this.layout = buildAtlasLayout(graph);
    // The arrangement is URL-driven (the surface's shape toggle), exactly like
    // Sigma's `layout`. The in-canvas mode buttons nudge it afterwards.
    this.mode = mode;
  }

  init(container: HTMLElement): void {
    this.host = container;
    container.classList.add('worldview-atlas');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'worldview-atlas-canvas';
    this.world = document.createElement('div');
    this.world.className = 'worldview-atlas-world';
    container.append(this.canvas, this.world);
    this.ctx = this.canvas.getContext('2d');
    container.addEventListener('mousedown', this.startPanHandler);
    container.addEventListener('mousemove', this.hoverHandler);
    container.addEventListener('wheel', this.zoomHandler, { passive: false });
    window.addEventListener('mousemove', this.moveHandler);
    window.addEventListener('mouseup', this.upHandler);
    window.addEventListener('resize', this.resizeHandler);
    this.resize();
    this.fit();
    this.draw();
  }

  destroy(): void {
    this.host?.removeEventListener('mousedown', this.startPanHandler);
    this.host?.removeEventListener('mousemove', this.hoverHandler);
    this.host?.removeEventListener('wheel', this.zoomHandler);
    window.removeEventListener('mousemove', this.moveHandler);
    window.removeEventListener('mouseup', this.upHandler);
    window.removeEventListener('resize', this.resizeHandler);
    this.canvas?.remove();
    this.world?.remove();
    this.cardPool.length = 0;
    this.visibleCards.clear();
    this.host = null;
    this.canvas = null;
    this.world = null;
    this.ctx = null;
    this.listeners.select.clear();
    this.listeners.doubleClick.clear();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.draw();
  }

  setColorMode(): void {
    // Atlas uses semantic type styling; deployment heat remains Sigma-specific.
  }

  setHiddenTypes(types: ReadonlySet<string>): void {
    this.hidden = new Set(types);
    this.draw();
  }

  setLocalMode(root: string | null, depth = 1): LocalState {
    this.localRoot = root && this.graph.hasNode(root) ? root : null;
    this.localVisible.clear();
    if (this.localRoot) {
      this.localVisible.add(this.localRoot);
      let frontier = [this.localRoot];
      for (let level = 0; level < depth; level += 1) {
        const next: string[] = [];
        for (const node of frontier) {
          this.graph.forEachNeighbor(node, (neighbor) => {
            if (!this.localVisible.has(neighbor)) {
              this.localVisible.add(neighbor);
              next.push(neighbor);
            }
          });
        }
        frontier = next;
      }
      this.fit();
    }
    this.draw();
    return { root: this.localRoot, depth, visibleCount: this.localRoot ? this.localVisible.size : this.graph.order };
  }

  selectNode(key: string | null): void {
    this.selected = key && this.graph.hasNode(key) ? key : null;
    this.draw();
  }

  getNodeData(key: string): NodeData | null {
    return nodeDataForGraph(this.graph, key);
  }

  searchNodes(query: string): SearchResult[] {
    return searchGraph(this.graph, query);
  }

  onNodeSelect(listener: (key: string | null) => void): () => void {
    this.listeners.select.add(listener);
    return () => this.listeners.select.delete(listener);
  }

  onNodeDoubleClick(listener: (key: string) => void): () => void {
    this.listeners.doubleClick.add(listener);
    return () => this.listeners.doubleClick.delete(listener);
  }

  setMode(mode: AtlasMode): void {
    this.mode = mode;
    this.fit();
    this.draw();
  }

  zoomBy(factor: number): void {
    this.scale = Math.max(0.001, Math.min(3, this.scale * factor));
    this.draw();
  }

  fit(): void {
    if (!this.host) return;
    const bounds = this.layout.bounds[this.mode];
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const availableWidth = Math.max(1, this.host.clientWidth - PADDING * 2);
    const availableHeight = Math.max(1, this.host.clientHeight - PADDING * 2);
    this.scale = Math.min(1.05, availableWidth / width, availableHeight / height);
    this.tx = (this.host.clientWidth - width * this.scale) / 2 - bounds.minX * this.scale;
    this.ty = (this.host.clientHeight - height * this.scale) / 2 - bounds.minY * this.scale;
  }

  private resize(): void {
    if (!this.host || !this.canvas || !this.ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.host.clientWidth * dpr;
    this.canvas.height = this.host.clientHeight * dpr;
    this.canvas.style.width = `${this.host.clientWidth}px`;
    this.canvas.style.height = `${this.host.clientHeight}px`;
    this.draw();
  }

  private point(node: AtlasNode): { x: number; y: number } {
    const position = this.layout.positions[this.mode].get(node.id) ?? { x: 0, y: 0 };
    return { x: position.x * this.scale + this.tx, y: position.y * this.scale + this.ty };
  }

  private visible(node: AtlasNode): boolean {
    if (this.hidden.has(node.entityType)) return false;
    if (this.localRoot && !this.localVisible.has(node.id)) return false;
    const point = this.point(node);
    return point.x + node.halfWidth * this.scale >= 0 && point.x - node.halfWidth * this.scale <= (this.host?.clientWidth ?? 0)
      && point.y + 44 * this.scale >= 0 && point.y - 44 * this.scale <= (this.host?.clientHeight ?? 0);
  }

  private draw(): void {
    if (!this.ctx || !this.canvas || !this.world) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    const dark = this.theme === 'dark';
    for (const edge of this.layout.edges) {
      const source = this.layout.byId.get(edge.source);
      const target = this.layout.byId.get(edge.target);
      if (!source || !target || (!this.visible(source) && !this.visible(target))) continue;
      const a = this.point(source);
      const b = this.point(target);
      this.ctx.beginPath();
      this.ctx.moveTo(a.x, a.y);
      this.ctx.bezierCurveTo(a.x + (b.x - a.x) * 0.45, a.y, b.x - (b.x - a.x) * 0.45, b.y, b.x, b.y);
      this.ctx.setLineDash(edge.tree ? [] : [3, 5]);
      this.ctx.strokeStyle = edge.tree ? (dark ? 'rgba(129,140,248,.58)' : 'rgba(67,56,202,.48)') : (dark ? 'rgba(16,185,129,.35)' : 'rgba(5,150,105,.32)');
      this.ctx.lineWidth = edge.tree ? 1.5 : 1.2;
      this.ctx.stroke();
    }
    this.ctx.setLineDash([]);
    for (const card of this.visibleCards) {
      card.style.display = 'none';
      this.cardPool.push(card);
    }
    this.visibleCards.clear();
    if (this.scale < CARD_ZOOM) {
      // Level of detail: keep the graph legible while zoomed out. The old
      // Atlas rendered lightweight dots here instead of mounting DOM cards.
      for (const node of this.layout.nodes) {
        if (!this.visible(node)) continue;
        const point = this.point(node);
        const hot = this.selected ?? this.hovered;
        const neighbor = hot ? node.id === hot || this.graph.hasEdge(node.id, hot) || this.graph.hasEdge(hot, node.id) : true;
        this.ctx.beginPath();
        this.ctx.fillStyle = neighbor ? (node.kind === 'root' ? '#6366f1' : node.kind === 'section' ? '#10b981' : '#94a3b8') : 'rgba(120,120,130,.28)';
        this.ctx.arc(point.x, point.y, (node.kind === 'root' ? 7 : node.kind === 'section' ? 5 : 3.5), 0, Math.PI * 2);
        this.ctx.fill();
      }
      return;
    }
    for (const node of this.layout.nodes) {
      if (!this.visible(node)) continue;
      const point = this.point(node);
      const card = this.cardPool.pop() ?? document.createElement('button');
      if (!card.dataset.atlasBound) {
        card.type = 'button';
        card.dataset.testid = 'atlas-node';
        card.innerHTML = `<span class="atlas-node-kicker"><i class="atlas-node-pip"></i><span class="atlas-node-kicker-text"></span></span><span class="atlas-node-title"></span><span class="atlas-node-subtitle"></span><span class="atlas-node-degree"></span>`;
        card.addEventListener('click', () => {
          if (this.dragMoved) return;
          const key = card.dataset.nodeKey;
          if (key) this.listeners.select.forEach((listener) => listener(key));
        });
        card.addEventListener('dblclick', (event) => {
          event.preventDefault();
          const key = card.dataset.nodeKey;
          if (key) this.listeners.doubleClick.forEach((listener) => listener(key));
        });
        this.world.appendChild(card);
        card.dataset.atlasBound = 'true';
      }
      card.style.display = 'flex';
      card.dataset.nodeKey = node.id;
      this.visibleCards.add(card);
      const hot = this.selected ?? this.hovered;
      const neighbors = hot ? new Set(this.graph.neighbors(hot)) : null;
      card.className = `atlas-node atlas-node-${node.kind}${node.id === this.selected ? ' is-selected' : ''}${node.id === this.hovered ? ' is-hovered' : ''}${hot && node.id !== hot && !neighbors?.has(node.id) ? ' is-faded' : ''}`;
      card.style.left = `${point.x}px`;
      card.style.top = `${point.y}px`;
      (card.querySelector('.atlas-node-kicker-text') as HTMLElement).textContent = node.kicker;
      (card.querySelector('.atlas-node-subtitle') as HTMLElement).textContent = node.sub ?? '';
      (card.querySelector('.atlas-node-subtitle') as HTMLElement).style.display = node.sub ? '' : 'none';
      (card.querySelector('.atlas-node-title') as HTMLElement).textContent = node.title;
      (card.querySelector('.atlas-node-subtitle') as HTMLElement).textContent = node.subtitle;
      (card.querySelector('.atlas-node-degree') as HTMLElement).textContent = String(node.degree);
    }
  }

  private startPan(event: MouseEvent): void {
    if (event.button !== 0) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('.atlas-node');
    if (card) {
      const key = card.dataset.nodeKey;
      const origin = key ? this.layout.positions[this.mode].get(key) : undefined;
      if (!key || !origin) return;
      this.dragging = {
        key,
        pointerX: event.clientX,
        pointerY: event.clientY,
        originX: origin.x,
        originY: origin.y,
      };
      this.dragMoved = false;
      this.host?.classList.add('is-dragging');
      return;
    }
    this.panning = { x: event.clientX, y: event.clientY, tx: this.tx, ty: this.ty };
    this.host?.classList.add('is-panning');
  }

  private move(event: MouseEvent): void {
    if (this.dragging) {
      // Screen delta → world delta (positions live in layout space).
      const dx = (event.clientX - this.dragging.pointerX) / this.scale;
      const dy = (event.clientY - this.dragging.pointerY) / this.scale;
      if (!this.dragMoved && Math.abs(dx * this.scale) + Math.abs(dy * this.scale) < 3) return;
      this.dragMoved = true;
      this.layout.positions[this.mode].set(this.dragging.key, {
        x: this.dragging.originX + dx,
        y: this.dragging.originY + dy,
      });
      this.draw();
      return;
    }
    if (!this.panning) return;
    this.tx = this.panning.tx + event.clientX - this.panning.x;
    this.ty = this.panning.ty + event.clientY - this.panning.y;
    this.draw();
  }

  private endPan(): void {
    this.panning = null;
    if (this.dragging) {
      this.dragging = null;
      this.host?.classList.remove('is-dragging');
      // Swallow the click the browser fires after a drag (see the card's
      // click handler) so releasing a moved node does not re-select it.
      if (this.dragMoved) window.setTimeout(() => { this.dragMoved = false; }, 0);
    }
    this.host?.classList.remove('is-panning');
  }

  private hover(event: MouseEvent): void {
    const node = (event.target as HTMLElement).closest<HTMLElement>('.atlas-node')?.dataset.nodeKey ?? null;
    if (node === this.hovered) return;
    this.hovered = node;
    this.draw();
  }

  private zoom(event: WheelEvent): void {
    if ((event.target as HTMLElement).closest('.atlas-controls')) return;
    event.preventDefault();
    this.scale = Math.max(0.001, Math.min(3, this.scale * (1 - event.deltaY * 0.0015)));
    this.draw();
  }
}
