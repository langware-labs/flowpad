import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * GraphWorkflow — a folder-backed flow document (backend:
 * flow_sdk/builtin/graph_workflow.py). graph.json (semantic) + display.json
 * (layout) live in the folder at `asset_ref`; read/write them via the
 * folder FSRef (whiteboard pattern). Runs + injection go through the
 * graphWorkflows service.
 */
export interface IGraphWorkflow extends IEntity {
  name?: string;
  description?: string;
  asset_ref?: string;
  /** The flow's active switch. */
  enabled?: boolean;
}

@registerEntity
export class GraphWorkflow extends APIEntity<GraphWorkflow> implements IGraphWorkflow {
  name?: string;
  description?: string;
  asset_ref?: string;
  enabled?: boolean;
  static type: string = 'graph_workflow';

  constructor(entity: Partial<IGraphWorkflow> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.description = entity.description ?? '';
    this.asset_ref = entity.asset_ref ?? '';
    this.enabled = entity.enabled ?? true;
  }
}
