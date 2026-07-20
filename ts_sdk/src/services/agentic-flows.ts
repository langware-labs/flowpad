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
  node_type: 'trigger' | 'agent' | 'function';
  name?: string;
  node_data: Record<string, unknown>;
}

export interface FlowDocEdge {
  id: string;
  from: { node: string; event: string };
  to: { node: string };
}

/** Per-flow knobs (run retention + loop budgets) — flow_doc.FlowConfig. */
export interface FlowConfig {
  retention_runs?: number;
  max_hops?: number;
  max_processes?: number;
  deadline_s?: number;
}

export interface FlowDoc {
  version: number;
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  config?: FlowConfig;
  nodes: FlowDocNode[];
  edges: FlowDocEdge[];
}

/** A registered FlowFunction (GET /agentic-flows/functions — the picker feed). */
export interface FlowFunctionInfo {
  name: string;
  meaning?: string | null;
  is_async?: boolean;
}

/** A function node's effective runtime (mirror of FlowNodeDef.function_runtime). */
export function functionRuntime(node: FlowDocNode): 'inline' | 'subprocess' {
  const explicit = String(node.node_data.runtime ?? '');
  if (explicit === 'inline' || explicit === 'subprocess') return explicit;
  return String(node.node_data.function ?? '').endsWith('.py') ? 'subprocess' : 'inline';
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

  /** The FlowFunction registry — feeds the Function node picker. */
  async listFunctions(): Promise<FlowFunctionInfo[] | undefined> {
    return apiClient.get('/agentic-flows/functions');
  }

  /** Re-inject a run's recorded ENTRY events into a fresh run (real re-execution). */
  async replayRun(flowId: string, runId: string): Promise<{ run_id: string } | undefined> {
    return apiClient.post(`/agentic-flows/${flowId}/runs/${runId}/replay`, {});
  }

  /** Re-deliver one past execution's recorded input to its node, in a fresh run. */
  async reexecute(flowId: string, runId: string, seq: number): Promise<{ run_id: string } | undefined> {
    return apiClient.post(`/agentic-flows/${flowId}/reexecute`, { run_id: runId, seq });
  }

  /** A run's full journal (from the flow folder's runs/<id>.jsonl). */
  async fetchRunJournal(flowId: string, runId: string): Promise<RunJournalEntry[] | undefined> {
    return apiClient.get(`/agentic-flows/${flowId}/runs/${runId}`);
  }
}

export const agenticFlows = new AgenticFlowsClient();
export default agenticFlows;
