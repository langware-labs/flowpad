/**
 * Graph Workflows v2 store (zustand) — one open flow at a time.
 *
 * Semantic truth is the flow folder's graph.json (doc); layout truth is
 * display.json. Both load/persist through the folder FSRef injected by the
 * view (whiteboard pattern). Live run/node state is push-driven from the
 * agenticFlows service streams.
 */
import { create } from 'zustand';
import type {
  GraphWorkflowDoc,
  GraphWorkflowDocEdge,
  GraphWorkflowDocNode,
  GraphWorkflowNodeStatusMessage,
  GraphWorkflowRunEventMessage,
  RunSummary,
} from '@sdk/services/graph-workflows';

export interface DisplayDoc {
  version: number;
  nodes: Record<string, { x: number; y: number }>;
}

export interface NodeLiveStatus {
  phase: GraphWorkflowNodeStatusMessage['phase'] | 'idle';
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
  pulsingEdges: Set<string>;
  selectedNodeId: string | null;
  selectedRunId: string | null;
  panelTab: 'inject' | 'runs' | 'palette';
  bootError: string | null;
  connected: boolean;
  /** Injected by the view: persistence + navigation. */
  persistDoc?: (doc: GraphWorkflowDoc) => void;
  persistDisplay?: (display: DisplayDoc) => void;
  openProcess?: (processId: string) => void;

  reset: (flowId: string | null) => void;
  setFlow: (opts: { flowId: string; name: string; enabled: boolean; doc: GraphWorkflowDoc; display: DisplayDoc }) => void;
  setWriters: (w: {
    persistDoc: (doc: GraphWorkflowDoc) => void;
    persistDisplay: (display: DisplayDoc) => void;
    openProcess: (processId: string) => void;
  }) => void;
  mutateDoc: (fn: (doc: GraphWorkflowDoc) => GraphWorkflowDoc) => void;
  moveNode: (nodeId: string, x: number, y: number) => void;
  setRuns: (runs: RunSummary[]) => void;
  applyRunEvent: (msg: GraphWorkflowRunEventMessage) => void;
  applyNodeStatus: (msg: GraphWorkflowNodeStatusMessage) => void;
  setProcStatus: (processId: string, st: ProcLiveStatus) => void;
  clearProcStatus: (processId: string) => void;
  pulseEdge: (edgeId: string) => void;
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
  pulsingEdges: new Set(),
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

  applyRunEvent: (msg) => {
    if (msg.flow_id !== get().flowId) return;
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
            get().pulseEdge(e.id);
          }
        }
      }
    }
  },

  applyNodeStatus: (msg) => {
    if (msg.flow_id !== get().flowId) return;
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

  pulseEdge: (edgeId) => {
    const next = new Set(get().pulsingEdges);
    next.add(edgeId);
    set({ pulsingEdges: next });
    setTimeout(() => {
      const after = new Set(useStudio.getState().pulsingEdges);
      after.delete(edgeId);
      set({ pulsingEdges: after });
    }, 1800);
  },

  selectNode: (id) => set({ selectedNodeId: id }),
  selectRun: (id) => set({ selectedRunId: id }),
  setPanelTab: (panelTab) => set({ panelTab }),
  setBootError: (bootError) => set({ bootError }),
  setConnected: (connected) => set({ connected }),
}));
