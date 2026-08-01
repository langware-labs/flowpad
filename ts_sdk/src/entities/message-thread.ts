/**
 * MessageThread — one thread of ingested cloud messages
 * (flow_sdk/builtin/message_thread.py).
 *
 * `conversation_id` is MANY-to-one: several threads may render inside one
 * conversation, which is what a merge produces. The counters are backend
 * projections — the packed row renders from `message_count` +
 * `head_message_id` WITHOUT loading the thread's messages, which is the whole
 * reason they exist (the conversation view fetches a bounded 500-message
 * window, so counting client-side is wrong for a real mailbox).
 */
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IMessageThread extends IEntity {
  /** The channel: gmail | slack | jira. The badge axis. */
  channel?: string;
  /** The provider's own thread handle (Gmail threadId, Slack thread_ts, …). */
  thread_key?: string;
  /** Which conversation shows this thread. Repointed by a merge. */
  conversation_id?: string;
  title?: string;
  message_count?: number;
  head_message_id?: string | null;
  last_message_at?: string | null;
}

@registerEntity
export class MessageThread extends APIEntity<MessageThread> implements IMessageThread {
  static type: string = 'message_thread';

  channel: string = '';
  thread_key: string = '';
  conversation_id: string = '';
  title: string = '';
  message_count: number = 0;
  head_message_id: string | null = null;
  last_message_at: string | null = null;

  constructor(entity: Partial<IMessageThread> = {}) {
    super(entity);
    this.channel = entity.channel ?? '';
    this.thread_key = entity.thread_key ?? '';
    this.conversation_id = entity.conversation_id ?? '';
    this.title = entity.title ?? '';
    this.message_count = entity.message_count ?? 0;
    this.head_message_id = entity.head_message_id ?? null;
    this.last_message_at = entity.last_message_at ?? null;
  }

  /** Whether this thread is worth packing — a single message renders inline. */
  get isPacked(): boolean {
    return this.message_count > 1;
  }
}
