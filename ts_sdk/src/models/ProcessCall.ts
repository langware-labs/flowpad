/**
 * A call that rides a message — the TS mirror of `flow_sdk/schema/data_spec/process_call_spec.py`.
 * The call travels as a `process_call-<call_id>` attachment; its answer, a `ReturnedValue`, as
 * `returned_value-<call_id>`. Both are values in the attachment's `prompt_preview`, never entities.
 */
export const PROCESS_CALL_TYPE = 'process_call';
export const RETURNED_VALUE_TYPE = 'returned_value';

export interface ProcessCall {
  call_id: string;
  /** Today always an agent op (`compute_op.agent`). */
  exe?: { spec_kind?: string; agent?: string; prompt?: string };
  /** `status`: the answer carries the outcome and one sentence, never the output. */
  reply?: 'status' | 'full';
}
