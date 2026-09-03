/**
 * MessageThread — one thread of ingested cloud messages
 * (flow_sdk/builtin/message_thread.py).
 *
 * `conversation_id` is MANY-to-one: several threads may render inside one
 * conversation, which is what a merge produces. `message_count` is a backend
 * projection so the packed row can show a size WITHOUT loading the thread —
 * the conversation view fetches a bounded 500-message window, so counting
 * client-side is wrong for any real mailbox.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

export interface IMessageThread extends IEntity {
  owner?: string | null;
  /** The channel: gmail | slack | jira. The badge axis. */
  channel?: string;
  /** The provider's own thread handle (Gmail threadId, Slack thread_ts, …). */
  thread_key?: string;
  /** Which conversation shows this thread. Repointed by a merge. */
  conversation_id?: string;
  title?: string;
  message_count?: number;
}

// `implements IMessageThread` only checks the class; it contributes no members, so every
// field declared solely on IMessageThread read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageThread extends EntityMerge<IMessageThread> {}

@registerEntity
export class MessageThread extends APIEntity<MessageThread> implements IMessageThread {
  static type: string = 'message_thread';

  channel: string = '';
  thread_key: string = '';
  /** Whose inbox this thread belongs to — a user or agent typeid string. */
  owner: string | null = null;
  conversation_id: string = '';
  title: string = '';
  message_count: number = 0;

  constructor(entity: Partial<IMessageThread> = {}) {
    super(entity);
    this.channel = entity.channel ?? '';
    this.thread_key = entity.thread_key ?? '';
    this.owner = entity.owner ?? null;
    this.conversation_id = entity.conversation_id ?? '';
    this.title = entity.title ?? '';
    this.message_count = entity.message_count ?? 0;
  }
}
