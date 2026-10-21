/**
 * ComputeOp — one checkable action (flow_sdk/builtin/compute_op.py):
 * `agentic-assets/compute_op/<name>/compute_op.json`, with its notes in `setup.md`.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { CliResult, ReturnedValue } from '../models/ReturnedValue';

/** The backend ShapeForm grammar: kind, record fields, or one list element shape. */
export type ShapeForm = string | { [field: string]: ShapeForm } | [ShapeForm];

/** Durable admission is not completed output: only result carries ReturnedValue. */
export interface ComputeCall<T = unknown> {
  call_id: string;
  invocation_id: string;
  block: string;
  project_id: string | null;
  input_present: boolean;
  input: unknown;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
  created_at: string;
  completed_at: string | null;
  /** Exact child executor attached during execution, or supplied by its final answer. */
  executor: string | null;
  executor_pid: number;
  executor_started: number;
  result: ReturnedValue<T> | null;
  error: string | null;
}

export interface IComputeOp extends IEntity {
  name?: string;
  label?: string;
  description?: string;
  subkind?: string;
  shipped?: boolean;
  durable_calls_supported?: boolean;
  input?: ShapeForm | null;
  output?: ShapeForm | null;
  output_spec_kind?: string | null;
  input_shape?: ShapeForm | null;
  output_shape?: ShapeForm | null;
}

export interface ComputeOp extends EntityMerge<IComputeOp> {}

@registerEntity
export class ComputeOp extends APIEntity<ComputeOp> implements IComputeOp {
  static type: string = 'compute_op';

  name: string = '';
  label: string = '';
  description: string = '';
  subkind: string = '';
  /** Ships with Flowpad: its commands are ours and run unprompted. */
  shipped: boolean = false;
  /** Only backend serialization asserts support; old servers leave this absent. */
  durable_calls_supported?: boolean;
  input?: ShapeForm | null;
  output?: ShapeForm | null;
  output_spec_kind?: string | null;
  input_shape?: ShapeForm | null;
  output_shape?: ShapeForm | null;

  /** Re-apply the payload: class-field initializers run after `super(json)`. */
  constructor(json: IComputeOp | undefined = undefined) {
    super(json as never);
    if (json) dataManager.deepAssign(this, json);
  }

  /** Is it done? Runs the op's completion check (`GET compute_op/<id>/check`). */
  async check(): Promise<CliResult> {
    return dataManager.callFlowAction<CliResult>(new ActionInfo('check', ComputeOp.type, this.id, 'GET'));
  }

  /** Run it (`POST compute_op/<id>/run`). `approved` is the person's say-so for an op that does
   *  not ship with Flowpad; the backend refuses such an op without it. */
  async run(approved: boolean): Promise<ReturnedValue> {
    const action = new ActionInfo('run', ComputeOp.type, this.id, 'POST');
    action.bodyParameters = { approved };
    return dataManager.callFlowAction(action);
  }

  /** Admit work durably; disconnecting does not cancel or replay it. */
  async start<T = unknown>(input?: unknown, options: { approved?: boolean } = {}): Promise<ComputeCall<T>> {
    const action = new ActionInfo('start', ComputeOp.type, this.id, 'POST');
    action.bodyParameters = { approved: options.approved ?? false, ...(input === undefined ? {} : { input }) };
    return dataManager.callAction<unknown, ComputeCall<T>>(action);
  }

  /** Read the same call after reconnect; this never starts work. */
  async get_call<T = unknown>(callId: string): Promise<ComputeCall<T>> {
    const action = new ActionInfo('get_call', ComputeOp.type, this.id, 'GET');
    action.queryParameters = { call_id: callId };
    return dataManager.callAction<unknown, ComputeCall<T>>(action);
  }

  /** Invoke a typed block. Schemas on the backend validate input and output;
   * T describes the expected output to the caller, not runtime validation. */
  async call<T = unknown>(input?: unknown, options: { approved?: boolean } = {}): Promise<ReturnedValue<T>> {
    const action = new ActionInfo('run', ComputeOp.type, this.id, 'POST');
    action.bodyParameters = { approved: options.approved ?? false, answer_tagged: true, ...(input === undefined ? {} : { input }) };
    return dataManager.callFlowAction<ReturnedValue<T>>(action);
  }
}
