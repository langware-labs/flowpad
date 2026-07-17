/**
 * FlowManager client — the SDK face of the backend agentic-flow orchestrator
 * (flow_sdk/flow_manager/). Emit topic events, fetch the wiring snapshot,
 * read the journal, and subscribe to the live event stream.
 *
 * The topic matcher here is the TS mirror of
 * flow_sdk/flow_manager/matcher.py — keep the two in step.
 */

import { EventEmitter } from 'events';
import apiClient from '../client';
import type {
  FlowNodeStatusMessage,
  TopicEventEnvelope,
  TopicEventMessage,
} from '../websocket';

export type { FlowNodeStatusMessage } from '../websocket';

// ── matcher (mirror of flow_sdk/flow_manager/matcher.py) ─────────────────────

/** True iff `topic` equals `pattern` or lives in its subtree. */
export function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.trim().toLowerCase();
  const t = topic.trim().toLowerCase();
  return t === p || t.startsWith(`${p}.`);
}

/** Ancestor chain of a topic name, root first, self last: "a.b.c" → ["a","a.b","a.b.c"]. */
export function topicAncestors(topic: string): string[] {
  const segments = topic.split('.');
  return segments.map((_, i) => segments.slice(0, i + 1).join('.'));
}

const TOPIC_SEGMENT_RE = /^[a-z0-9_-]+$/;

export function isValidTopicName(name: string): boolean {
  if (!name) return false;
  return name.split('.').every((seg) => TOPIC_SEGMENT_RE.test(seg));
}

// ── graph snapshot types (GET /api/v1/topics/graph) ──────────────────────────

export interface FlowGraphSnapshot {
  topics: Array<{ id: string; name: string; description?: string; color?: string }>;
  nodes: Array<{
    id: string;
    name: string;
    description?: string;
    program_kind: string;
    program_ref: string;
    prompt?: string;
    model_size?: 'sm' | 'md' | 'lg';
    delivery_mode: string;
    workdir?: string;
    enabled: boolean;
    current_process_id?: string;
    execution_mode: 'serial' | 'parallel';
    parallel_limit: number;
    merge_identical: boolean;
  }>;
  agentic_flows: Array<{
    id: string;
    name: string;
    enabled: boolean;
    member_node_ids: string[];
    max_depth: number;
    max_processes: number;
    deadline_s: number;
  }>;
  edges: Array<{ kind: 'listens' | 'emits'; node_id: string; topic_id: string; topic: string }>;
}

export interface EmitEnvelopeInput {
  correlation_id?: string;
  depth?: number;
  causation?: string[];
  source?: string;
  scope?: string;
}

// ── manager ──────────────────────────────────────────────────────────────────

class FlowManagerClient extends EventEmitter {
  private _initialized = false;

  /** Subscribe to the live journal stream. Idempotent. */
  async bootstrap(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    const { ConnectionManager } = await import('../websocket');
    ConnectionManager.getInstance().on('on_topic_event_msg', (msg: TopicEventMessage) => {
      this.emit('topic_event', msg.event);
    });
    ConnectionManager.getInstance().on(
      'on_flow_node_status_msg',
      (msg: FlowNodeStatusMessage) => {
        this.emit('node_status', msg);
      },
    );
  }

  /** Emit a topic event through the backend FlowManager. Returns the routed envelope. */
  async emitTopic(
    topic: string,
    payload: Record<string, unknown> = {},
    envelope?: EmitEnvelopeInput,
  ): Promise<TopicEventEnvelope | undefined> {
    return apiClient.post<TopicEventEnvelope>('/topics/emit', { topic, payload, envelope });
  }

  /** Full wiring snapshot for canvas rendering. */
  async fetchGraph(): Promise<FlowGraphSnapshot | undefined> {
    return apiClient.get<FlowGraphSnapshot>('/topics/graph');
  }

  /** Recent routed events; pass a correlation id to follow one chain. */
  async fetchJournal(opts: { limit?: number; correlationId?: string } = {}): Promise<
    TopicEventEnvelope[] | undefined
  > {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.correlationId) params.set('corr', opts.correlationId);
    const qs = params.toString();
    return apiClient.get<TopicEventEnvelope[]>(`/topics/journal${qs ? `?${qs}` : ''}`);
  }
}

export const flowManager = new FlowManagerClient();
export default flowManager;
