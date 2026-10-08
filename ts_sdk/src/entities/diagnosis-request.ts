import { registerEntity } from '../APIEntity';
import { FlowpadDiagnosis, IFlowpadDiagnosis } from './flowpad-diagnosis';

/**
 * DiagnosisRequest — a FlowpadDiagnosis someone ELSE runs (`flow diagnose <id>`) and writes into
 * on the hub. Its diagnosis fields show the latest run. Backend type: `diagnosis_request`
 * (`flow_sdk/builtin/diagnosis_request.py`); opened and read through its actions.
 */
export interface IDiagnosisRequest extends IFlowpadDiagnosis {
  instructions?: string; // what the runner's agent is asked to do
  ask_permission?: boolean; // whether `flow diagnose <id>` asks the runner anything (off: it never does)
  write_expires_at?: string; // ISO end of the window in which the id accepts runs
  max_run_bytes?: number; // largest run the hub accepts
  llm_endpoint_typeid?: string; // the public hub budget a runner spends, when funded
  run_count?: number; // runs the hub has kept
  last_run_at?: string; // ISO time of the latest run
}

@registerEntity
export class DiagnosisRequest extends FlowpadDiagnosis implements IDiagnosisRequest {
  instructions?: string;
  ask_permission?: boolean;
  write_expires_at?: string;
  max_run_bytes?: number;
  llm_endpoint_typeid?: string;
  run_count?: number;
  last_run_at?: string;
  static type: string = 'diagnosis_request';

  constructor(entity: Partial<IDiagnosisRequest> = {}) {
    super(entity);
    this.instructions = entity.instructions;
    this.ask_permission = entity.ask_permission;
    this.write_expires_at = entity.write_expires_at;
    this.max_run_bytes = entity.max_run_bytes;
    this.llm_endpoint_typeid = entity.llm_endpoint_typeid;
    this.run_count = entity.run_count;
    this.last_run_at = entity.last_run_at;
  }
}
