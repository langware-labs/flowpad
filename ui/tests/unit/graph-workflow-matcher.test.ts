/** GraphWorkflows v2 SDK surface — entity registration + service constants. */
import { describe, expect, it } from 'vitest';
import {
  CATCH_ALL_EVENT,
  EXTERNAL_SOURCE,
  agenticFlows,
} from '../../../ts_sdk/src/services/graph-workflows';
import { GraphWorkflow, GraphWorkflowRun, GraphWorkflowNode } from '../../../ts_sdk/src/entities';

describe('graph-workflows v2 SDK surface', () => {
  it('registers the flow entities with the factory', () => {
    expect(GraphWorkflow.type).toBe('graph_workflow');
    expect(GraphWorkflowRun.type).toBe('graph_workflow_run');
    expect(GraphWorkflowNode.type).toBe('flow_node');
    const flow = new GraphWorkflow({ name: 'f' });
    expect(flow.enabled).toBe(true);
    const run = new GraphWorkflowRun({ flow_id: 'x' });
    expect(run.status).toBe('running');
    const node = new GraphWorkflowNode({});
    expect(node.node_type).toBe('function');
  });

  it('exports the routing constants (mirror of graph_workflow_doc.py)', () => {
    expect(CATCH_ALL_EVENT).toBe('*');
    expect(EXTERNAL_SOURCE).toBe('$external');
    expect(typeof agenticFlows.inject).toBe('function');
    expect(typeof agenticFlows.listRuns).toBe('function');
    expect(typeof agenticFlows.fetchRunJournal).toBe('function');
  });
});
