/** AgenticFlows v2 SDK surface — entity registration + service constants. */
import { describe, expect, it } from 'vitest';
import {
  CATCH_ALL_EVENT,
  EXTERNAL_SOURCE,
  agenticFlows,
} from '../../../ts_sdk/src/services/agentic-flows';
import { AgenticFlow, AgenticFlowRun, FlowNode } from '../../../ts_sdk/src/entities';

describe('agentic-flows v2 SDK surface', () => {
  it('registers the flow entities with the factory', () => {
    expect(AgenticFlow.type).toBe('agentic_flow');
    expect(AgenticFlowRun.type).toBe('agentic_flow_run');
    expect(FlowNode.type).toBe('flow_node');
    const flow = new AgenticFlow({ name: 'f' });
    expect(flow.enabled).toBe(true);
    const run = new AgenticFlowRun({ flow_id: 'x' });
    expect(run.status).toBe('running');
    const node = new FlowNode({});
    expect(node.node_type).toBe('process_runner');
  });

  it('exports the routing constants (mirror of flow_doc.py)', () => {
    expect(CATCH_ALL_EVENT).toBe('*');
    expect(EXTERNAL_SOURCE).toBe('$external');
    expect(typeof agenticFlows.inject).toBe('function');
    expect(typeof agenticFlows.listRuns).toBe('function');
    expect(typeof agenticFlows.fetchRunJournal).toBe('function');
  });
});
