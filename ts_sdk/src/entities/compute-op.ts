/**
 * ComputeOp — one checkable action (flow_sdk/builtin/compute_op.py):
 * `agentic-assets/compute_op/<name>/compute_op.json`, with its notes in `setup.md`.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { CliResult, ReturnedValue } from '../models/ReturnedValue';

export interface IComputeOp extends IEntity {
  name?: string;
  label?: string;
  description?: string;
  subkind?: string;
  shipped?: boolean;
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
}
