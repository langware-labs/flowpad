/**
 * GraphWorkflows client — the SDK face of GraphWorkflowManager v2
 * (flow_sdk/graph_workflow_manager/). Inject events into a flow, list its runs
 * and read a run's journal.
 *
 * Liveness is NOT here: run and node beats arrive on the unified event bus as
 * `graph_workflow.run.event` / `graph_workflow.node.status`, so consumers use
 * `useOnTag` directly. The two payload shapes below are what those events carry
 * in `data` (plus `flow_id`, which the envelope carries in `target`); they are
 * plain payloads now, not WS frames.
 *
 * graph.json / display.json read+write go through the flow entity's folder
 * FSRef (the whiteboard pattern) — this service carries only the runtime
 * surfaces.
 */

import apiClient from '../client';

/** One beat of a run's internal stream — the `data` of a
 *  `graph_workflow.run.event` envelope. The flow is the envelope's `target`. */
export interface RunEventPayload {
  run_id: string;
  /** run_start | event | run_end */
  kind: string;
  event: string;
  data: Record<string, unknown>;
  node: string;
  status: string;
  ts: string;
}

/** One scheduler transition for a flow node — live counters and status lines;
 *  the `data` of a `graph_workflow.node.status` envelope. */
export interface NodeStatusPayload {
  run_id: string;
  node_id: string;
  phase: 'queued' | 'merged' | 'started' | 'finished' | 'failed' | 'waiting';
  /** Node runtime counts AFTER this transition. */
  queued: number;
  active: number;
  /** started → {program_kind, process_id?}; finished → {duration_ms, stdout?...}; failed → {error}. */
  detail: Record<string, unknown>;
  ts: string;
}

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

/** One file an execution read or wrote. */
export interface ArtifactFile {
  name: string;
  direction: 'input' | 'output';
  size: number;
  previewable: boolean;
  /** Absolute on-disk path — shown so the file is findable outside the app. */
  path: string;
}

/** One execution's I/O record. An agent node's files live under its AGENTIC
 *  PROCESS record, not the run's, hence `process_id`. */
export interface ArtifactExecution {
  key: string;
  label: string;
  seq: number;
  node: string;
  process_id?: string | null;
  files: ArtifactFile[];
}

export interface RunArtifacts {
  executions: ArtifactExecution[];
}

export interface ArtifactContent {
  name: string;
  size: number;
  path: string;
  text: string;
}

class GraphWorkflowsClient {
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

  /** Every execution of a run, with the files it read and wrote. */
  async fetchRunArtifacts(flowId: string, runId: string): Promise<RunArtifacts | undefined> {
    return apiClient.get(`/graph-workflows/${flowId}/runs/${runId}/artifacts`);
  }

  /** One artifact's text. `key` and `name` must come from `fetchRunArtifacts`. */
  async fetchRunArtifact(
    flowId: string,
    runId: string,
    key: string,
    name: string,
  ): Promise<ArtifactContent | undefined> {
    const q = `key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`;
    return apiClient.get(`/graph-workflows/${flowId}/runs/${runId}/artifact?${q}`);
  }
}

export const graphWorkflows = new GraphWorkflowsClient();
export default graphWorkflows;
