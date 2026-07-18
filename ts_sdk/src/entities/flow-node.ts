import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * FlowNode — derived record-keeping row for a node inside an AgenticFlow
 * (backend: flow_sdk/builtin/flow_node.py). The SOURCE OF TRUTH for nodes is
 * the flow's graph.json; these rows exist for ownership/cleanup/queries only.
 */
export interface IFlowNode extends IEntity {
  name?: string;
  flow_id?: string;
  node_type?: 'trigger' | 'agent' | 'function';
  program_ref?: string;
  enabled?: boolean;
}

@registerEntity
export class FlowNode extends APIEntity<FlowNode> implements IFlowNode {
  name?: string;
  flow_id?: string;
  node_type?: 'trigger' | 'agent' | 'function';
  program_ref?: string;
  enabled?: boolean;
  static type: string = 'flow_node';

  constructor(entity: Partial<IFlowNode> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.flow_id = entity.flow_id ?? '';
    this.node_type = entity.node_type ?? 'function';
    this.program_ref = entity.program_ref;
    this.enabled = entity.enabled ?? true;
  }
}
