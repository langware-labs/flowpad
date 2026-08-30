import type { EntityMerge } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IProcessResult extends IEntity {
  agentic_process_id?: string;
  status?: string;
  result_type?: string;
  source_session_id?: string;
  worker_session_id?: string;
  agenticProcessId?: string;
  resultType?: string;
  sourceSessionId?: string;
  workerSessionId?: string;
}

// `implements IProcessResult` only checks the class; it contributes no members, so every
// field declared solely on IProcessResult read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProcessResult extends EntityMerge<IProcessResult> {}

@registerEntity
export class ProcessResult extends APIEntity<ProcessResult> implements IProcessResult {
  static type: string = 'process_result';

  agentic_process_id?: string;
  status?: string;
  result_type?: string;
  source_session_id?: string;
  worker_session_id?: string;

  constructor(entity: Partial<IProcessResult> = {}) {
    super(entity as IEntity);
    this.agentic_process_id = entity.agentic_process_id ?? entity.agenticProcessId;
    this.status = entity.status ?? 'running';
    this.result_type = entity.result_type ?? entity.resultType;
    this.source_session_id = entity.source_session_id ?? entity.sourceSessionId;
    this.worker_session_id = entity.worker_session_id ?? entity.workerSessionId;
    this.root_vfs_path = entity.root_vfs_path ?? (entity as any).rootVfsPath;
  }
}
