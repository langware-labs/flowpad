/**
 * Graph Workflows v2 store (zustand) — one open flow at a time.
 *
 * Semantic truth is the flow folder's graph.json (doc); layout truth is
 * display.json. Both load/persist through the folder FSRef injected by the
 * view (whiteboard pattern). Live run/node state is push-driven off the
 * unified event bus (docs/flow-events.md phase 8 Tier B).
 */
import { create } from 'zustand';
import { targetMatches } from '@sdk/tags/EventBus';
import { tagMatches } from '@sdk/tags/grammar';
import type {
  GraphWorkflowDoc,
  GraphWorkflowDocEdge,
  GraphWorkflowDocNode,
  NodeStatusPayload,
  RunEventPayload,
  RunSummary,
} from '@sdk/services/graph-workflows';

/** How long a flashed edge or inlet stays lit. */
const FLASH_MS = 1800;

/** Live dim-timers, keyed by flashed id. Module-level rather than store state:
 *  they are cleanup handles, never rendered. */
const _flashTimers = new Map<string, number>();

/** Canvas id for a subscription inlet. `id` is optional in the doc schema, so
 *  position is the fallback — the canvas and this store must agree. */
export function inletIdFor(subId: string | undefined, index: number): string {
  return `sub:${subId || index}`;
}

export interface DisplayDoc {
  version: number;
  nodes: Record<string, { x: number; y: number }>;
}

export interface NodeLiveStatus {
  phase: NodeStatusPayload['phase'] | 'idle';
  queued: number;
  active: number;
  startedAt?: number;
  processId?: string;
  error?: string;
  lastDurationMs?: number;
  lastFinishedAt?: number;
  lastStdout?: string;
  lastStderr?: string;
  lastExitCode?: number;
}

export interface ProcLiveStatus {
  workerStatus: string;
  processStatus: string;
  busy: boolean;
  ts: number;
}

export interface StudioState {
  flowId: string | null;
  flowName: string;
  flowEnabled: boolean;
  doc: GraphWorkflowDoc | null;
  display: DisplayDoc;
  runs: RunSummary[];
  nodeStatus: Record<string, NodeLiveStatus>;
  procStatus: Record<string, ProcLiveStatus>;
  /** Edge ids and inlet ids currently lit — one set, one mechanism. */
  hot: Set<string>;
  selectedNodeId: string | null;
  selectedRunId: string | null;
  panelTab: 'inject' | 'runs' | 'palette';
  bootError: string | null;
  connected: boolean;
  /** Injected by the view: persistence + navigation. */
  persistDoc?: (doc: GraphWorkflowDoc) => void;
  persistDisplay?: (display: DisplayDoc) => void;
  /** Preview the runs of one node/execution — see RunPreviewRoot. */
  previewRuns?: (target: { scope: Record<string, string>; runId?: string | null; title: string }) => void;

  reset: (flowId: string | null) => void;
  setFlow: (opts: { flowId: string; name: string; enabled: boolean; doc: GraphWorkflowDoc; display: DisplayDoc }) => void;
  setWriters: (w: {
    persistDoc: (doc: GraphWorkflowDoc) => void;
    persistDisplay: (display: DisplayDoc) => void;
    previewRuns: (target: { scope: Record<string, string>; runId?: string | null; title: string }) => void;
  }) => void;
  mutateDoc: (fn: (doc: GraphWorkflowDoc) => GraphWorkflowDoc) => void;
  moveNode: (nodeId: string, x: number, y: number) => void;
  setRuns: (runs: RunSummary[]) => void;
  applyRunEvent: (msg: RunEventPayload) => void;
  applyNodeStatus: (msg: NodeStatusPayload) => void;
  setProcStatus: (processId: string, st: ProcLiveStatus) => void;
  clearProcStatus: (processId: string) => void;
  /** Light these ids (edges or inlets) briefly. */
  flash: (ids: string[]) => void;
  /** A bus event arrived: light every subscription inlet that would have matched. */
  noteBusEvent: (tag: string, target: string, scope?: string[]) => void;
  selectNode: (id: string | null) => void;
  selectRun: (id: string | null) => void;
  setPanelTab: (t: StudioState['panelTab']) => void;
  setBootError: (msg: string | null) => void;
  setConnected: (v: boolean) => void;
}

export function newNodeId(): string {
  return crypto.randomUUID();
}

export type { GraphWorkflowDoc, GraphWorkflowDocEdge, GraphWorkflowDocNode };

const EMPTY_DISPLAY: DisplayDoc = { version: 1, nodes: {} };

export const useStudio = create<StudioState>((set, get) => ({
  flowId: null,
  flowName: '',
  flowEnabled: true,
  doc: null,
  display: EMPTY_DISPLAY,
  runs: [],
  nodeStatus: {},
  procStatus: {},
  hot: new Set(),
  selectedNodeId: null,
  selectedRunId: null,
  panelTab: 'palette',
  bootError: null,
  connected: false,

  reset: (flowId) =>
    set({
      flowId,
      flowName: '',
      doc: null,
      display: EMPTY_DISPLAY,
      runs: [],
      nodeStatus: {},
      procStatus: {},
      selectedNodeId: null,
      selectedRunId: null,
      bootError: null,
    }),

  setFlow: ({ flowId, name, enabled, doc, display }) =>
    set({ flowId, flowName: name, flowEnabled: enabled, doc, display }),

  setWriters: (w) => set(w),

  mutateDoc: (fn) => {
    const doc = get().doc;
    if (!doc) return;
    const next = fn(structuredClone(doc));
    set({ doc: next });
    get().persistDoc?.(next);
  },

  moveNode: (nodeId, x, y) => {
    const next: DisplayDoc = {
      ...get().display,
      nodes: { ...get().display.nodes, [nodeId]: { x, y } },
    };
    set({ display: next });
    get().persistDisplay?.(next);
  },

  setRuns: (runs) => set({ runs }),

  // The subscription filters by target, so anything reaching these reducers is
  // already this flow's — no flow_id re-check.
  applyRunEvent: (msg) => {
    if ((msg.kind === 'run_start' || msg.kind === 'run_end') && !get().selectedRunId) {
      // Auto-focus the live run so the Runs panel follows without a click.
      set({ selectedRunId: msg.run_id });
    }
    if (msg.kind === 'event' && msg.node) {
      // Pulse every edge leaving (node, event) — the traversal visual.
      const doc = get().doc;
      if (doc) {
        for (const e of doc.edges) {
          if (e.from.node === msg.node && (e.from.event === msg.event || e.from.event === '*')) {
            get().flash([e.id]);
          }
        }
      }
    }
  },

  applyNodeStatus: (msg) => {
    const prev = get().nodeStatus[msg.node_id] ?? { phase: 'idle', queued: 0, active: 0 };
    const next: NodeLiveStatus = {
      ...prev,
      phase: msg.phase,
      queued: msg.queued,
      active: msg.active,
    };
    if (msg.phase === 'started') {
      next.startedAt = prev.active > 0 && prev.startedAt ? prev.startedAt : Date.now();
      next.error = undefined;
      const pid = msg.detail?.process_id;
      if (typeof pid === 'string') next.processId = pid;
    }
    if (msg.phase === 'finished' || msg.phase === 'failed') {
      if (msg.phase === 'failed') next.error = typeof msg.detail?.error === 'string' ? msg.detail.error : 'failed';
      else next.lastDurationMs = Number(msg.detail?.duration_ms ?? 0) || undefined;
      next.lastFinishedAt = Date.now();
      next.lastStdout = typeof msg.detail?.stdout === 'string' ? msg.detail.stdout : prev.lastStdout;
      next.lastStderr = typeof msg.detail?.stderr === 'string' ? msg.detail.stderr : prev.lastStderr;
      next.lastExitCode =
        typeof msg.detail?.exit_code === 'number' ? msg.detail.exit_code : prev.lastExitCode;
      if (msg.active === 0) next.startedAt = undefined;
    }
    set({ nodeStatus: { ...get().nodeStatus, [msg.node_id]: next } });
  },

  setProcStatus: (processId, st) =>
    set({ procStatus: { ...get().procStatus, [processId]: st } }),
  clearProcStatus: (processId) => {
    const rest = { ...get().procStatus };
    delete rest[processId];
    set({ procStatus: rest });
  },

  // One flash mechanism for edges AND inlets: same "light it, dim it" motion,
  // and edge ids never collide with the `sub:` inlet ids. A repeat hit while
  // still lit reschedules its own timer rather than stacking a second one, so a
  // burst costs one store update in and one out.
  flash: (ids) => {
    if (!ids.length) return;
    const next = new Set(get().hot);
    for (const id of ids) {
      next.add(id);
      const pending = _flashTimers.get(id);
      if (pending !== undefined) clearTimeout(pending);
      _flashTimers.set(
        id,
        setTimeout(() => {
          _flashTimers.delete(id);
          const after = new Set(useStudio.getState().hot);
          after.delete(id);
          set({ hot: after });
        }, FLASH_MS) as unknown as number,
      );
    }
    set({ hot: next });
  },

  noteBusEvent: (tag, target, scope) => {
    const subscriptions = get().doc?.subscriptions;
    if (!subscriptions?.length) return;
    const lit: string[] = [];
    subscriptions.forEach((s, i) => {
      // Mirrors the backend's three delivery filters (bus.py _sub_matches +
      // the scope check). An empty target or scope means "any".
      if (!tagMatches(s.pattern, tag)) return;
      if (s.target && !targetMatches(s.target, target)) return;
      if (s.scope?.length && !s.scope.some((want) => scope?.includes(want))) return;
      lit.push(inletIdFor(s.id, i));
    });
    get().flash(lit);
  },

  selectNode: (id) => set({ selectedNodeId: id }),
  selectRun: (id) => set({ selectedRunId: id }),
  setPanelTab: (panelTab) => set({ panelTab }),
  setBootError: (bootError) => set({ bootError }),
  setConnected: (connected) => set({ connected }),
}));
