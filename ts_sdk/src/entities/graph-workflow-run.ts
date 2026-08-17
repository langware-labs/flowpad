import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * GraphWorkflowRun — one execution of an GraphWorkflow (backend:
 * flow_sdk/builtin/graph_workflow_run.py). The row is start/end bookkeeping;
 * the full trace lives in the flow folder's runs/<id>.jsonl, served via
 * GET /api/v1/graph-workflows/<flow>/runs/<run>.
 */
export type GraphWorkflowRunStatus = 'running' | 'complete' | 'tripped' | 'failed';

export interface IGraphWorkflowRun extends IEntity {
  name?: string;
  flow_id?: string;
  status?: GraphWorkflowRunStatus;
  started_at?: string;
  ended_at?: string;
  event_count?: number;
  execution_count?: number;
  error?: string;
}

@registerEntity
export class GraphWorkflowRun extends APIEntity<GraphWorkflowRun> implements IGraphWorkflowRun {
  name?: string;
  flow_id?: string;
  status?: GraphWorkflowRunStatus;
  started_at?: string;
  ended_at?: string;
  event_count?: number;
  execution_count?: number;
  error?: string;
  static type: string = 'graph_workflow_run';

  constructor(entity: Partial<IGraphWorkflowRun> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.flow_id = entity.flow_id ?? '';
    this.status = entity.status ?? 'running';
    this.started_at = entity.started_at;
    this.ended_at = entity.ended_at;
    this.event_count = entity.event_count ?? 0;
    this.execution_count = entity.execution_count ?? 0;
    this.error = entity.error;
  }
}
