import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * FlowNode — a station in the flow graph (backend: flow_sdk/builtin/flow_node.py).
 * Binds a program (callback / skill / instruction) to execution defaults;
 * executions are separate AgenticProcess entities. Wiring is relationship-based
 * (Listens declared, Emits observed) — fetched via the /api/v1/topics/graph
 * snapshot, not entity fields.
 */
export type FlowNodeProgramKind = 'callback' | 'skill' | 'instruction';
export type FlowNodeDeliveryMode = 'spawn' | 'inject';
export type FlowNodeExecutionMode = 'serial' | 'parallel';

export interface IFlowNode extends IEntity {
  name?: string;
  description?: string;
  program_kind?: FlowNodeProgramKind;
  /** callback_name / skill name / instruction text, per program_kind. */
  program_ref?: string;
  /** Extra prompt appended to the program on delivery (skill args / task framing). */
  prompt?: string;
  /** Model size for spawned agent executions: sm (haiku) | md (sonnet) | lg (opus). */
  model_size?: 'sm' | 'md' | 'lg';
  delivery_mode?: FlowNodeDeliveryMode;
  workdir?: string;
  visible?: boolean;
  /** Live AgenticProcess id (inject mode only). */
  current_process_id?: string;
  /** serial = one execution at a time; parallel = up to parallel_limit concurrent. */
  execution_mode?: FlowNodeExecutionMode;
  parallel_limit?: number;
  /** Drop an incoming event when an identical one is already pending in the queue. */
  merge_identical?: boolean;
  enabled?: boolean;
}

@registerEntity
export class FlowNode extends APIEntity<FlowNode> implements IFlowNode {
  name?: string;
  description?: string;
  program_kind?: FlowNodeProgramKind;
  program_ref?: string;
  prompt?: string;
  model_size?: 'sm' | 'md' | 'lg';
  delivery_mode?: FlowNodeDeliveryMode;
  workdir?: string;
  visible?: boolean;
  current_process_id?: string;
  execution_mode?: FlowNodeExecutionMode;
  parallel_limit?: number;
  merge_identical?: boolean;
  enabled?: boolean;
  static type: string = 'flow_node';

  constructor(entity: Partial<IFlowNode> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.description = entity.description;
    this.program_kind = entity.program_kind ?? 'callback';
    this.program_ref = entity.program_ref ?? '';
    this.prompt = entity.prompt;
    this.model_size = entity.model_size ?? 'sm';
    this.delivery_mode = entity.delivery_mode ?? 'spawn';
    this.workdir = entity.workdir;
    this.visible = entity.visible ?? false;
    this.current_process_id = entity.current_process_id;
    this.execution_mode = entity.execution_mode ?? 'serial';
    this.parallel_limit = entity.parallel_limit ?? 3;
    this.merge_identical = entity.merge_identical ?? false;
    this.enabled = entity.enabled ?? true;
  }
}
