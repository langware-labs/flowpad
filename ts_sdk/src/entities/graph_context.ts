import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * GraphContext — a frozen snapshot of the global context (a list of typeids).
 * The saved "context" half of an automation (agentic process = prompt + context).
 * Created by the "Open Context" freeze action; viewed at dock/graph_context/<id>.
 */
export interface IGraphContext extends IEntity {
  /** Flat list of frozen typeid strings ("<type>-<id>"). Source of truth. */
  context_typeids?: string[];
  /** ContextEntitiesEnum slot name → typeid string, for grouping/labeling. */
  slot_map?: Record<string, string>;
}

// `implements IGraphContext` only checks the class; it contributes no members, so every
// field declared solely on IGraphContext read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GraphContext extends Omit<IGraphContext, 'expand' | 'id' | 'is_private' | 'members'> {}

@registerEntity
export class GraphContext extends APIEntity<GraphContext> implements IGraphContext {
  context_typeids?: string[];
  slot_map?: Record<string, string>;
  static type: string = 'graph_context';

  constructor(entity: Partial<IGraphContext> = {}) {
    super(entity);
    this.context_typeids = entity.context_typeids ?? [];
    this.slot_map = entity.slot_map ?? {};
  }
}
