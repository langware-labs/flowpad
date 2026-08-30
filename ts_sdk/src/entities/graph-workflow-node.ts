import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

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

// `implements IGraphWorkflowNode` only checks the class; it contributes no members, so every
// field declared solely on IGraphWorkflowNode read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GraphWorkflowNode extends EntityMerge<IGraphWorkflowNode> {}

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
