/**
 * GraphWorkflows client — the SDK face of GraphWorkflowManager v2
 * (flow_sdk/graph_workflow_manager/). Inject events into a flow, list its runs, read a
 * run's journal, and subscribe to the live run/node streams.
 *
 * graph.json / display.json read+write go through the flow entity's folder
 * FSRef (the whiteboard pattern) — this service carries only the runtime
 * surfaces.
 */

import { EventEmitter } from 'events';
import apiClient from '../client';
import type { GraphWorkflowNodeStatusMessage, GraphWorkflowRunEventMessage } from '../websocket';

export type { GraphWorkflowNodeStatusMessage, GraphWorkflowRunEventMessage } from '../websocket';

/** Wire shape of one graph.json node (see graph_workflow_doc.py). */
export interface GraphWorkflowDocNode {
  id: string;
  node_type: 'trigger' | 'agent' | 'function';
  name?: string;
  node_data: Record<string, unknown>;
}

export interface GraphWorkflowDocEdge {
  id: string;
  from: { node: string; event: string };
  to: { node: string };
}

/** Per-flow knobs (run retention + loop budgets) — graph_workflow_doc.GraphWorkflowConfig. */
export interface GraphWorkflowConfig {
  retention_runs?: number;
  max_hops?: number;
  max_processes?: number;
  deadline_s?: number;
}

/** A graph-level unified-bus subscription (graph_workflow_doc.GraphWorkflowSubscriptionDef). */
export interface GraphWorkflowSubscription {
  id?: string;
  pattern: string;
  target?: string;
  scope?: string[];
  event?: string;
  node?: string;
}

export interface GraphWorkflowDoc {
  version: number;
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  config?: GraphWorkflowConfig;
  subscriptions?: GraphWorkflowSubscription[];
  nodes: GraphWorkflowDocNode[];
  edges: GraphWorkflowDocEdge[];
}

/** A registered GraphWorkflowFunction (GET /graph-workflows/functions — the picker feed). */
export interface GraphWorkflowFunctionInfo {
  name: string;
  meaning?: string | null;
  is_async?: boolean;
}

/** A function node's effective runtime (mirror of GraphWorkflowNodeDef.function_runtime). */
export function functionRuntime(node: GraphWorkflowDocNode): 'inline' | 'subprocess' {
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

class GraphWorkflowsClient extends EventEmitter {
  private _initialized = false;

  /** Subscribe to the live run/node streams. Idempotent. */
  async bootstrap(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    const { ConnectionManager } = await import('../websocket');
    const cm = ConnectionManager.getInstance();
    cm.on('on_flow_run_event_msg', (msg: GraphWorkflowRunEventMessage) => {
      this.emit('run_event', msg);
    });
    cm.on('on_flow_node_status_msg', (msg: GraphWorkflowNodeStatusMessage) => {
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
    return apiClient.post(`/graph-workflows/${flowId}/inject`, {
      event,
      data,
      execution_id: opts.executionId,
      target_node: opts.targetNode,
    });
  }

  /** Recent runs of a flow, newest first. */
  async listRuns(flowId: string): Promise<RunSummary[] | undefined> {
    return apiClient.get(`/graph-workflows/${flowId}/runs`);
  }

  /** The GraphWorkflowFunction registry — feeds the Function node picker. */
  async listFunctions(): Promise<GraphWorkflowFunctionInfo[] | undefined> {
    return apiClient.get('/graph-workflows/functions');
  }

  /** Re-inject a run's recorded ENTRY events into a fresh run (real re-execution). */
  async replayRun(flowId: string, runId: string): Promise<{ run_id: string } | undefined> {
    return apiClient.post(`/graph-workflows/${flowId}/runs/${runId}/replay`, {});
  }

  /** Re-deliver one past execution's recorded input to its node, in a fresh run. */
  async reexecute(flowId: string, runId: string, seq: number): Promise<{ run_id: string } | undefined> {
    return apiClient.post(`/graph-workflows/${flowId}/reexecute`, { run_id: runId, seq });
  }

  /** A run's full journal (from the flow folder's runs/<id>.jsonl). */
  async fetchRunJournal(flowId: string, runId: string): Promise<RunJournalEntry[] | undefined> {
    return apiClient.get(`/graph-workflows/${flowId}/runs/${runId}`);
  }
}

export const graphWorkflows = new GraphWorkflowsClient();
export default graphWorkflows;
