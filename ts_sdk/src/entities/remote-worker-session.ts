import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * RemoteWorkerSession — a host/guest remote-execution session living inside a
 * CollaborationRoom (alongside its files/assets). The guest sends Prompts; the
 * host's worker runs them and returns PromptResults. Asymmetric: the host runs
 * the real local AgenticProcess (`host_process_id`), the guest requests and
 * watches — reconstructing the turn stream from the Prompt/PromptResult exchange
 * that rides `conversation_id`'s messages. `status` is a host-authoritative
 * projection so the guest can render live state without a local worker.
 */
export interface IRemoteWorkerSession extends IEntity {
  conversation_id?: string | null;
  host_user_id?: string | null;
  guest_user_id?: string | null;
  /** Host only — null on the guest's mirror. */
  host_process_id?: string | null;
  project_id?: string | null;
  status?: string;
  last_activity_at?: string | null;
  started_at?: string | null;
}

@registerEntity
export class RemoteWorkerSession
  extends APIEntity<RemoteWorkerSession>
  implements IRemoteWorkerSession
{
  static type: string = 'remote_worker_session';

  conversation_id: string | null = null;
  host_user_id: string | null = null;
  guest_user_id: string | null = null;
  host_process_id: string | null = null;
  project_id: string | null = null;
  status: string = 'idle';
  last_activity_at: string | null = null;
  started_at: string | null = null;

  constructor(entity: Partial<IRemoteWorkerSession> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
  }

  /** True when `userId` is this session's host (the executor). */
  isHost(userId: string | null | undefined): boolean {
    return !!this.host_user_id && userId === this.host_user_id;
  }
}
