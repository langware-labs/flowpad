import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';

/**
 * RemoteWorkerSession — a host/guest remote-execution session living inside a
 * CollaborationRoom (alongside its files/assets). The guest sends Prompts; the
 * host's worker runs them and returns PromptCompletions. Asymmetric: the host runs
 * the real local AgenticProcess (`host_process_id`), the guest requests and
 * watches — reconstructing the turn stream from the Prompt/PromptCompletion exchange
 * that rides `conversation_id`'s messages. `status` is a host-authoritative
 * projection so the guest can render live state without a local worker.
 */
/** Live-session lifecycle. Mirrors flow_sdk.builtin.remote_worker_session.
 *  RemoteWorkerSessionStatus exactly: DRAFT (guest-local, nothing shared) →
 *  PENDING (first prompt sent, awaiting host approval) → IDLE⇄RUNNING (active
 *  turns, PAUSED as a host-side hold) → ENDED/DECLINED (terminal). */
export enum RemoteWorkerSessionStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  IDLE = 'idle',
  RUNNING = 'running',
  PAUSED = 'paused',
  ERROR = 'error',
  ENDED = 'ended',
  DECLINED = 'declined',
}

/** Approved and accepting prompts (the two active turn sub-states). */
export function isSessionActive(status: string | null | undefined): boolean {
  return status === RemoteWorkerSessionStatus.IDLE || status === RemoteWorkerSessionStatus.RUNNING;
}

/** Absorbing states — the session accepts no further prompts. */
export function isSessionTerminal(status: string | null | undefined): boolean {
  return status === RemoteWorkerSessionStatus.ENDED || status === RemoteWorkerSessionStatus.DECLINED;
}

export interface IRemoteWorkerSession extends IEntity {
  conversation_id?: string | null;
  collaboration_room_id?: string | null;
  host_user_id?: string | null;
  guest_user_id?: string | null;
  host_name?: string | null;
  guest_name?: string | null;
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
  collaboration_room_id: string | null = null;
  host_user_id: string | null = null;
  guest_user_id: string | null = null;
  host_name: string | null = null;
  guest_name: string | null = null;
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

  /** Tab / chip label. A RemoteWorkerSession has no name/uname/title, so the
   *  default chain would fall back to the synthetic `remote_worker_session-<id>`;
   *  name it after the counterpart instead (mirrors CollaborationRoom's join). */
  getDisplayName(): string | null {
    const other = this.guest_name || this.host_name;
    return other ? `Live session · ${other}` : 'Live session';
  }

  /**
   * Host cuts off remote access to their machine: marks the session ENDED and
   * best-effort stops the host worker so no further guest prompts run.
   */
  public async disconnect(): Promise<void> {
    const info = new ActionInfo('disconnect', this.typeId.type, this.typeId.id, 'POST');
    await dataManager.callAction(info);
    this.status = 'ended';
  }

  private async lifecycleAction(verb: string, optimistic: RemoteWorkerSessionStatus): Promise<void> {
    const info = new ActionInfo(verb, this.typeId.type, this.typeId.id, 'POST');
    await dataManager.callAction(info);
    this.status = optimistic;
  }

  /** Host approves a PENDING session; queued prompts re-drive server-side. */
  public approve(): Promise<void> {
    return this.lifecycleAction('approve', RemoteWorkerSessionStatus.IDLE);
  }

  /** Host declines a PENDING session (terminal). */
  public decline(): Promise<void> {
    return this.lifecycleAction('decline', RemoteWorkerSessionStatus.DECLINED);
  }

  /** Host holds the session — inbound prompts bounce until resume. */
  public pause(): Promise<void> {
    return this.lifecycleAction('pause', RemoteWorkerSessionStatus.PAUSED);
  }

  /** Host lifts a pause (PAUSED → IDLE). */
  public resume(): Promise<void> {
    return this.lifecycleAction('resume', RemoteWorkerSessionStatus.IDLE);
  }
}
