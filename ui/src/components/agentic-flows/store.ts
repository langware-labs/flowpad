/**
 * Agentic Flows domain store (zustand).
 *
 * Liveness model (post-overhaul): node runtime state (queue/active/phase) is
 * driven ONLY by pushed `node_status` events — the snapshot poll is a slow
 * reconciliation, never the liveness source. Edge traffic counters and pulses
 * are keyed on scheduler phases (queued ≠ started). Process worker status
 * arrives via per-process watcher subscriptions (proc-watch.ts).
 */
import { create } from 'zustand';
import { topicMatches } from '@sdk/services/flow-manager';
import type { FlowGraphSnapshot, FlowNodeStatusMessage } from '@sdk/services/flow-manager';
import type { TopicEventEnvelope } from '@sdk/websocket';
import { edgeId } from './canvas/layout';

export interface NodeLiveStatus {
  phase: FlowNodeStatusMessage['phase'] | 'idle';
  queued: number;
  active: number;
  /** epoch ms when the current (oldest still-running) execution started */
  startedAt?: number;
  processId?: string;
  error?: string;
  lastDurationMs?: number;
  lastFinishedAt?: number;
  lastTopic?: string;
  correlationId?: string;
}

export interface ProcLiveStatus {
  workerStatus: string;
  processStatus: string;
  busy: boolean;
  ts: number;
}

export interface ExecutionEntry {
  processId?: string;
  programKind: string;
  topic: string;
  correlationId: string;
  startedAt: number;
  phase: 'running' | 'finished' | 'failed';
  durationMs?: number;
  error?: string;
}

export interface StudioState {
  snapshot: FlowGraphSnapshot | null;
  nodeStatus: Record<string, NodeLiveStatus>;
  /** edgeId → delivered-event count this session */
  edgeTraffic: Record<string, number>;
  procStatus: Record<string, ProcLiveStatus>;
  journal: TopicEventEnvelope[];
  pulsingEdges: Set<string>;
  selectedCorrelation: string | null;
  /** node inspector selection + which side panel is open */
  selectedNodeId: string | null;
  panelTab: 'emit' | 'journal' | 'chain' | 'wiring';
  /** recent executions per node (from node_status pushes), newest first */
  executions: Record<string, ExecutionEntry[]>;
  bootError: string | null;
  connected: boolean;
  /** In-app process navigation, injected by the view (navigation.openDock). */
  openProcess?: (processId: string) => void;
  setOpenProcess: (fn: (processId: string) => void) => void;
  selectNode: (id: string | null) => void;
  setPanelTab: (t: StudioState['panelTab']) => void;

  setSnapshot: (s: FlowGraphSnapshot) => void;
  applyNodeStatus: (msg: FlowNodeStatusMessage) => void;
  setProcStatus: (processId: string, st: ProcLiveStatus) => void;
  clearProcStatus: (processId: string) => void;
  pushEvent: (e: TopicEventEnvelope) => void;
  seedJournal: (events: TopicEventEnvelope[]) => void;
  pulseEdge: (edgeId: string) => void;
  pulseTopic: (topic: string, source?: string) => void;
  selectCorrelation: (corr: string | null) => void;
  setBootError: (msg: string | null) => void;
  setConnected: (v: boolean) => void;
  chainOutcome: (corr: string) => 'running' | 'complete' | 'tripped';
}

const JOURNAL_CAP = 500;

/** listens-edge ids on `nodeId` whose topic is a prefix of `eventTopic`. */
function listenEdgeIds(
  snapshot: FlowGraphSnapshot | null,
  nodeId: string,
  eventTopic: string,
): string[] {
  if (!snapshot) return [];
  return snapshot.edges
    .filter((e) => e.kind === 'listens' && e.node_id === nodeId && topicMatches(e.topic, eventTopic))
    .map((e) => edgeId(e.kind, e.node_id, e.topic_id));
}

export const useStudio = create<StudioState>((set, get) => ({
  snapshot: null,
  nodeStatus: {},
  edgeTraffic: {},
  procStatus: {},
  journal: [],
  pulsingEdges: new Set(),
  selectedCorrelation: null,
  selectedNodeId: null,
  panelTab: 'emit',
  executions: {},
  bootError: null,
  connected: false,

  setOpenProcess: (fn) => set({ openProcess: fn }),
  // Node selection drives the inspector drawer.
  selectNode: (id) => set({ selectedNodeId: id }),
  setPanelTab: (panelTab) => set({ panelTab }),

  // Snapshot is reconciliation only — never clobber pushed liveness state.
  setSnapshot: (snapshot) => set({ snapshot }),

  applyNodeStatus: (msg) => {
    const prev = get().nodeStatus[msg.node_id] ?? { phase: 'idle', queued: 0, active: 0 };
    const next: NodeLiveStatus = {
      ...prev,
      phase: msg.phase,
      queued: msg.queued,
      active: msg.active,
      lastTopic: msg.event_topic || prev.lastTopic,
      correlationId: msg.correlation_id || prev.correlationId,
    };
    if (msg.phase === 'queued') {
      // Traffic + pulse toward the node; execution hasn't started (#10).
      const traffic = { ...get().edgeTraffic };
      for (const id of listenEdgeIds(get().snapshot, msg.node_id, msg.event_topic)) {
        traffic[id] = (traffic[id] ?? 0) + 1;
        get().pulseEdge(id);
      }
      set({ edgeTraffic: traffic });
    }
    if (msg.phase === 'started') {
      next.startedAt = prev.active > 0 && prev.startedAt ? prev.startedAt : Date.now();
      next.error = undefined;
      const pid = msg.detail?.process_id;
      if (typeof pid === 'string') next.processId = pid;
      const entry: ExecutionEntry = {
        processId: typeof pid === 'string' ? pid : undefined,
        programKind: String(msg.detail?.program_kind ?? ''),
        topic: msg.event_topic,
        correlationId: msg.correlation_id,
        startedAt: Date.now(),
        phase: 'running',
      };
      const list = [entry, ...(get().executions[msg.node_id] ?? [])].slice(0, 10);
      set({ executions: { ...get().executions, [msg.node_id]: list } });
    }
    if (msg.phase === 'finished' || msg.phase === 'failed') {
      const failedNow = msg.phase === 'failed';
      if (failedNow) next.error = String(msg.detail?.error ?? 'failed');
      else next.lastDurationMs = Number(msg.detail?.duration_ms ?? 0) || undefined;
      next.lastFinishedAt = Date.now();
      if (msg.active === 0) next.startedAt = undefined;
      // Close the matching running execution (by process id, else oldest running).
      const list = [...(get().executions[msg.node_id] ?? [])];
      const pid = typeof msg.detail?.process_id === 'string' ? msg.detail.process_id : undefined;
      const idx = list.findIndex(
        (x) => x.phase === 'running' && (pid ? x.processId === pid : true),
      );
      if (idx >= 0) {
        list[idx] = {
          ...list[idx],
          phase: failedNow ? 'failed' : 'finished',
          durationMs: Number(msg.detail?.duration_ms ?? 0) || undefined,
          error: failedNow ? String(msg.detail?.error ?? 'failed') : undefined,
        };
        set({ executions: { ...get().executions, [msg.node_id]: list } });
      }
    }
    if (msg.phase === 'slot_freed') {
      if (msg.active === 0) next.startedAt = undefined;
    }
    set({ nodeStatus: { ...get().nodeStatus, [msg.node_id]: next } });
  },

  setProcStatus: (processId, st) =>
    set({ procStatus: { ...get().procStatus, [processId]: st } }),
  clearProcStatus: (processId) => {
    const { [processId]: _gone, ...rest } = get().procStatus;
    set({ procStatus: rest });
  },

  pushEvent: (e) =>
    set((st) => ({ journal: [...st.journal.slice(-(JOURNAL_CAP - 1)), e] })),

  seedJournal: (events) => set({ journal: events.slice(-JOURNAL_CAP) }),

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

  // Emit-side pulse: the emitter's emits edges only (delivery pulses come
  // from `queued` node_status events now).
  pulseTopic: (topic, source = '') => {
    const snap = get().snapshot;
    if (!snap) return;
    const traffic = { ...get().edgeTraffic };
    for (const e of snap.edges) {
      if (e.kind === 'emits' && e.topic === topic && source === `flow_node:${e.node_id}`) {
        const id = edgeId(e.kind, e.node_id, e.topic_id);
        traffic[id] = (traffic[id] ?? 0) + 1;
        get().pulseEdge(id);
      }
    }
    set({ edgeTraffic: traffic });
  },

  selectCorrelation: (corr) => set({ selectedCorrelation: corr }),

  setBootError: (bootError) => set({ bootError }),
  setConnected: (connected) => set({ connected }),

  chainOutcome: (corr) => {
    const st = get();
    const anyLive = Object.values(st.nodeStatus).some(
      (n) => n.correlationId === corr && (n.queued > 0 || n.active > 0),
    );
    if (anyLive) return 'running';
    const tripped = st.journal.some(
      (e) =>
        e.correlation_id === corr &&
        (e.dropped || e.topic.startsWith('flow.error')),
    );
    return tripped ? 'tripped' : 'complete';
  },
}));
