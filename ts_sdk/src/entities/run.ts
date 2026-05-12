import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export enum RunStatus {
  RUNNING = 'running',
  STOPPED = 'stopped',
  FAILED = 'failed',
}

export interface IRun extends IEntity {
  target_typeid_str?: string;
  process_id?: string;
  prompt_text?: string;
  status?: string;
  started_at?: string | null;
  ended_at?: string | null;
  draft_flow_message_id?: string | null;
  /** FlowMessage whose PROMPT attachment was approved to trigger this Run. */
  source_flow_message_id?: string | null;
}

@registerEntity
export class Run extends APIEntity<Run> implements IRun {
  target_typeid_str?: string;
  process_id?: string;
  prompt_text?: string;
  status?: string;
  started_at?: string | null;
  ended_at?: string | null;
  draft_flow_message_id?: string | null;
  source_flow_message_id?: string | null;
  static type: string = 'run';

  constructor(entity: Partial<IRun> = {}) {
    super(entity);
    this.target_typeid_str = entity.target_typeid_str;
    this.process_id = entity.process_id;
    this.prompt_text = entity.prompt_text;
    this.status = entity.status;
    this.started_at = entity.started_at;
    this.ended_at = entity.ended_at;
    this.draft_flow_message_id = entity.draft_flow_message_id;
    this.source_flow_message_id = entity.source_flow_message_id;
  }
}
