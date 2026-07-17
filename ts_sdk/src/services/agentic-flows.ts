/**
 * AgenticFlows client — the SDK face of FlowManager v2
 * (flow_sdk/flow_manager/). Inject events into a flow, list its runs, read a
 * run's journal, and subscribe to the live run/node streams.
 *
 * graph.json / display.json read+write go through the flow entity's folder
 * FSRef (the whiteboard pattern) — this service carries only the runtime
 * surfaces.
 */

import { EventEmitter } from 'events';
import apiClient from '../client';
import type { FlowNodeStatusMessage, FlowRunEventMessage } from '../websocket';

export type { FlowNodeStatusMessage, FlowRunEventMessage } from '../websocket';

/** Wire shape of one graph.json node (see flow_doc.py). */
export interface FlowDocNode {
  id: string;
  node_type: 'trigger' | 'process_runner' | 'pysdk';
  name?: string;
  node_data: Record<string, unknown>;
}

export interface FlowDocEdge {
  id: string;
  from: { node: string; event: string };
  to: { node: string };
}

export interface FlowDoc {
  version: number;
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  nodes: FlowDocNode[];
  edges: FlowDocEdge[];
}

/** The catch-all edge event. */
export const CATCH_ALL_EVENT = '*';
/** Virtual source node for external injections (edges may route from it). */
export const EXTERNAL_SOURCE = '$external';

export interface RunSummary {
  id: string;
  flow_id: string;
  status: 'running' | 'complete' | 'tripped' | 'failed';
  started_at?: string;
  ended_at?: string;
  event_count: number;
  execution_count: number;
  error?: string;
}

export interface RunJournalEntry {
  kind: string;
  ts: string;
  [key: string]: unknown;
}

class AgenticFlowsClient extends EventEmitter {
  private _initialized = false;

  /** Subscribe to the live run/node streams. Idempotent. */
  async bootstrap(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    const { ConnectionManager } = await import('../websocket');
    const cm = ConnectionManager.getInstance();
    cm.on('on_flow_run_event_msg', (msg: FlowRunEventMessage) => {
      this.emit('run_event', msg);
    });
    cm.on('on_flow_node_status_msg', (msg: FlowNodeStatusMessage) => {
      this.emit('node_status', msg);
    });
  }

  /** Deliver an event into a flow (starts a run, or joins `executionId`). */
  async inject(
    flowId: string,
    event: string,
    data: Record<string, unknown> = {},
    opts: { executionId?: string; targetNode?: string } = {},
  ): Promise<{ execution_id: string; event: string } | undefined> {
    return apiClient.post(`/agentic-flows/${flowId}/inject`, {
      event,
      data,
      execution_id: opts.executionId,
      target_node: opts.targetNode,
    });
  }

  /** Recent runs of a flow, newest first. */
  async listRuns(flowId: string): Promise<RunSummary[] | undefined> {
    return apiClient.get(`/agentic-flows/${flowId}/runs`);
  }

  /** A run's full journal (from the flow folder's runs/<id>.jsonl). */
  async fetchRunJournal(flowId: string, runId: string): Promise<RunJournalEntry[] | undefined> {
    return apiClient.get(`/agentic-flows/${flowId}/runs/${runId}`);
  }
}

export const agenticFlows = new AgenticFlowsClient();
export default agenticFlows;
