import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * GraphWorkflowNode — derived record-keeping row for a node inside an GraphWorkflow
 * (backend: flow_sdk/builtin/flow_node.py). The SOURCE OF TRUTH for nodes is
 * the flow's graph.json; these rows exist for ownership/cleanup/queries only.
 */
export interface IGraphWorkflowNode extends IEntity {
  name?: string;
  flow_id?: string;
  node_type?: 'trigger' | 'agent' | 'function';
  program_ref?: string;
  enabled?: boolean;
}

@registerEntity
export class GraphWorkflowNode extends APIEntity<GraphWorkflowNode> implements IGraphWorkflowNode {
  name?: string;
  flow_id?: string;
  node_type?: 'trigger' | 'agent' | 'function';
  program_ref?: string;
  enabled?: boolean;
  static type: string = 'graph_workflow_node';

  constructor(entity: Partial<IGraphWorkflowNode> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.flow_id = entity.flow_id ?? '';
    this.node_type = entity.node_type ?? 'function';
    this.program_ref = entity.program_ref;
    this.enabled = entity.enabled ?? true;
  }
}
