import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * AgenticFlow — a named boundary + policy over a flow subgraph (backend:
 * flow_sdk/builtin/agentic_flow.py). Carries no wiring — just the enable switch
 * and the loop-protection budget FlowManager charges correlation chains
 * against. (Note: the type id is `agentic_flow`; plain `flow` is the legacy
 * conversational Flow entity.)
 */
export interface IAgenticFlow extends IEntity {
  name?: string;
  description?: string;
  enabled?: boolean;
  /** FlowNode ids inside this boundary. */
  member_node_ids?: string[];
  max_depth?: number;
  max_processes?: number;
  deadline_s?: number;
}

@registerEntity
export class AgenticFlow extends APIEntity<AgenticFlow> implements IAgenticFlow {
  name?: string;
  description?: string;
  enabled?: boolean;
  member_node_ids?: string[];
  max_depth?: number;
  max_processes?: number;
  deadline_s?: number;
  static type: string = 'agentic_flow';

  constructor(entity: Partial<IAgenticFlow> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.description = entity.description;
    this.enabled = entity.enabled ?? true;
    this.member_node_ids = entity.member_node_ids ?? [];
    this.max_depth = entity.max_depth;
    this.max_processes = entity.max_processes;
    this.deadline_s = entity.deadline_s;
  }
}
