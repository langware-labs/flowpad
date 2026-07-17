import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * AgenticFlow — a folder-backed flow document (backend:
 * flow_sdk/builtin/agentic_flow.py). graph.json (semantic) + display.json
 * (layout) live in the folder at `asset_ref`; read/write them via the
 * folder FSRef (whiteboard pattern). Runs + injection go through the
 * agenticFlows service.
 */
export interface IAgenticFlow extends IEntity {
  name?: string;
  description?: string;
  asset_ref?: string;
  /** The flow's active switch. */
  enabled?: boolean;
}

@registerEntity
export class AgenticFlow extends APIEntity<AgenticFlow> implements IAgenticFlow {
  name?: string;
  description?: string;
  asset_ref?: string;
  enabled?: boolean;
  static type: string = 'agentic_flow';

  constructor(entity: Partial<IAgenticFlow> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.description = entity.description ?? '';
    this.asset_ref = entity.asset_ref ?? '';
    this.enabled = entity.enabled ?? true;
  }
}
