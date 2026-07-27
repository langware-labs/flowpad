import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * AgenticFlowRun — one execution of an AgenticFlow (backend:
 * flow_sdk/builtin/agentic_flow_run.py). The row is start/end bookkeeping;
 * the full trace lives in the flow folder's runs/<id>.jsonl, served via
 * GET /api/v1/agentic-flows/<flow>/runs/<run>.
 */
export type AgenticFlowRunStatus = 'running' | 'complete' | 'tripped' | 'failed';

export interface IAgenticFlowRun extends IEntity {
  name?: string;
  flow_id?: string;
  status?: AgenticFlowRunStatus;
  started_at?: string;
  ended_at?: string;
  event_count?: number;
  execution_count?: number;
  error?: string;
}

@registerEntity
export class AgenticFlowRun extends APIEntity<AgenticFlowRun> implements IAgenticFlowRun {
  name?: string;
  flow_id?: string;
  status?: AgenticFlowRunStatus;
  started_at?: string;
  ended_at?: string;
  event_count?: number;
  execution_count?: number;
  error?: string;
  static type: string = 'agentic_flow_run';

  constructor(entity: Partial<IAgenticFlowRun> = {}) {
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
