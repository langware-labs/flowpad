import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * PromptResult — the answer a host's worker produced for a Prompt, inside a
 * RemoteWorkerSession. Symmetric to {@link Prompt}: it rides back as a
 * `prompt_result-<id>` TYPE_ID attachment on a reply FlowMessage, carrying
 * `result_preview` so the guest reads it before the body downloads. A result is
 * turn-grained and may be more than text — `asset_refs` points at produced
 * files/assets.
 */
export interface IPromptResult extends IEntity {
  prompt_id?: string | null;
  remote_worker_session_id?: string | null;
  text?: string | null;
  result_preview?: string | null;
  asset_refs?: string[];
  status?: string;
  source_session_id?: string | null;
  host_process_id?: string | null;
}

@registerEntity
export class PromptResult extends APIEntity<PromptResult> implements IPromptResult {
  static type: string = 'prompt_result';

  prompt_id: string | null = null;
  remote_worker_session_id: string | null = null;
  text: string | null = null;
  result_preview: string | null = null;
  asset_refs: string[] = [];
  status: string = 'complete';
  source_session_id: string | null = null;
  host_process_id: string | null = null;

  constructor(entity: Partial<IPromptResult> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
    this.asset_refs = entity.asset_refs ?? [];
  }
}
