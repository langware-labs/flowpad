import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';
import { Conversation } from './conversation';

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
 *  turns) → ENDED/DECLINED (terminal). */
export enum RemoteWorkerSessionStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  IDLE = 'idle',
  RUNNING = 'running',
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

/** What happens to a captured reply. Proposed by the guest on the opening
 *  prompt, host-authoritative afterwards, editable in the session view.
 *  Mirrors flow_sdk.builtin.remote_worker_session.ReplyPolicy. */
export enum SessionReplyPolicy {
  /** Send as soon as captured. */
  AUTO = 'auto',
  /** Save as a host draft inside the session. */
  REVIEW = 'review',
}

/** Standing-grant scope accepted by the `approve` action's `remember` body. */
export type SessionRememberScope = 'project' | 'everywhere';

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
  /** Host only: the folder a "No project" session runs in. */
  workdir?: string | null;
  status?: string;
  last_activity_at?: string | null;
  started_at?: string | null;
  /** The main-thread prompt that opened this session — the card's anchor. */
  starting_message_id?: string | null;
  /** `SessionReplyPolicy`; null = auto. */
  reply_policy?: string | null;
  approved_at?: string | null;
  /** 'manual' | 'standing_grant'. */
  approved_via?: string | null;
}

@registerEntity
export class RemoteWorkerSession extends APIEntity<RemoteWorkerSession> implements IRemoteWorkerSession {
  static type: string = 'remote_worker_session';

  conversation_id: string | null = null;
  collaboration_room_id: string | null = null;
  host_user_id: string | null = null;
  guest_user_id: string | null = null;
  host_name: string | null = null;
  guest_name: string | null = null;
  host_process_id: string | null = null;
  project_id: string | null = null;
  workdir: string | null = null;
  status: string = 'idle';
  last_activity_at: string | null = null;
  started_at: string | null = null;
  starting_message_id: string | null = null;
  reply_policy: string | null = null;
  approved_at: string | null = null;
  approved_via: string | null = null;

  constructor(entity: Partial<IRemoteWorkerSession> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
  }

  /** True when `userId` is this session's host (the executor). */
  isHost(userId: string | null | undefined): boolean {
    return !!this.host_user_id && userId === this.host_user_id;
  }

  /** Which side of the session the viewer is on. Host/guest ids are CLOUD ids;
   *  a row carrying the host-local process is the host's own, whoever is signed in. */
  roleFor(cloudUserId: string | null | undefined): 'host' | 'guest' | 'observer' {
    if (this.isHost(cloudUserId) || !!this.host_process_id) return 'host';
    if (this.guest_user_id && this.guest_user_id === cloudUserId) return 'guest';
    return 'observer';
  }

  /** Effective reply policy — null/garbage reads as auto. */
  get effectiveReplyPolicy(): SessionReplyPolicy {
    return this.reply_policy === SessionReplyPolicy.REVIEW ? SessionReplyPolicy.REVIEW : SessionReplyPolicy.AUTO;
  }

  /** Tab / chip label. A RemoteWorkerSession has no name/uname/title, so the
   *  default chain would fall back to the synthetic `remote_worker_session-<id>`;
   *  name it after the counterpart — the guest on the host's machine, the host on
   *  the guest's. */
  getDisplayName(): string | null {
    const onHost = this.roleFor(dataContext.cloudUser?.id) === 'host';
    const other = onHost ? this.guest_name || this.host_name : this.host_name || this.guest_name;
    return other ? `Live session · ${other}` : 'Live session';
  }

  /**
   * Host cuts off remote access to their machine: marks the session ENDED and
   * best-effort stops the host worker so no further guest prompts run.
   */
  public disconnect(): Promise<void> {
    return this.lifecycleAction('disconnect', RemoteWorkerSessionStatus.ENDED);
  }

  private async lifecycleAction(
    verb: string,
    optimistic: RemoteWorkerSessionStatus,
    body?: Record<string, unknown>,
  ): Promise<void> {
    const info = new ActionInfo(verb, this.typeId.type, this.typeId.id, 'POST');
    if (body) info.bodyParameters = body;
    await dataManager.callAction(info);
    this.status = optimistic;
  }

  /** Host approves a PENDING session; queued prompts re-drive server-side.
   *  `remember` also writes the standing grant for this guest. `projectId` is
   *  where the session runs — required when neither the session nor its
   *  conversation has a project (a person-to-person chat has none by design);
   *  without it the host refuses (409) and the session stays pending.
   *  `scratch` is the host's "No project": the instance's one temp folder. */
  public approve(
    remember?: SessionRememberScope,
    projectId?: string,
    options: { scratch?: boolean } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (remember) body.remember = remember;
    if (options.scratch) body.scratch = true;
    else if (projectId) body.project_id = projectId;
    return this.lifecycleAction('approve', RemoteWorkerSessionStatus.IDLE, Object.keys(body).length ? body : undefined);
  }

  /** Open the conversation's live session before any prompt — or answer the one
   *  already open (one open session per conversation). The host is asked to approve. */
  public static async start(conversationId: string): Promise<RemoteWorkerSession> {
    const info = new ActionInfo('live-session', Conversation.type, conversationId, 'POST');
    const data = await dataManager.callAction<Record<string, unknown>, Partial<IRemoteWorkerSession>>(info);
    return new RemoteWorkerSession(data);
  }

  /** Host only: does approving need the host to pick where it runs first? True
   *  when neither this session nor its conversation names a project or folder. */
  public async needsProjectToApprove(): Promise<boolean> {
    if (this.project_id || this.workdir) return false;
    if (!this.conversation_id) return true;
    const conversation = await dataManager.getByTypeId<Conversation>(
      new TypeId(Conversation.type, this.conversation_id),
    );
    return !conversation?.project_id;
  }

  /** Edit the session's reply policy (host-authoritative `settings` action). */
  public async setReplyPolicy(policy: SessionReplyPolicy): Promise<void> {
    const info = new ActionInfo('settings', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { reply_policy: policy };
    await dataManager.callAction(info);
    this.reply_policy = policy;
  }

  /** Host declines a PENDING session (terminal). */
  public decline(): Promise<void> {
    return this.lifecycleAction('decline', RemoteWorkerSessionStatus.DECLINED);
  }
}
