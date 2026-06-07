import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export type FeedStatus = 'new' | 'dismissed' | 'expired';
export type FeedKind = 'message_suggest';

/** Payload (the `T`) for a FeedEntry of kind `message_suggest`. Mirrors the
 *  backend `MessageSuggest`. */
export interface IMessageSuggest {
  /** User-facing header line. */
  text: string;
  /** The (until-then hidden) support conversation this entry points at. */
  conversation_id: string;
  /** The summary FlowMessage in that conversation. */
  flow_message_id: string;
  /** Summary body, so the card renders without a follow-up fetch. */
  message_text: string;
}

export interface IFeedEntry extends IEntity {
  /** Discriminator naming which payload `feed_data` carries. */
  kind?: FeedKind | string;
  /** Visibility lifecycle — only `new` renders in the Feed. */
  feed_status?: FeedStatus | string;
  /** Serialized payload (a `MessageSuggest` for `message_suggest`). */
  feed_data?: IMessageSuggest | Record<string, unknown> | null;
}

@registerEntity
export class FeedEntry extends APIEntity<FeedEntry> implements IFeedEntry {
  kind?: FeedKind | string;
  feed_status?: FeedStatus | string;
  feed_data?: IMessageSuggest | Record<string, unknown> | null;
  static type: string = 'feed_entry';

  constructor(entity: Partial<IFeedEntry> = {}) {
    super(entity);
    this.kind = entity.kind ?? 'message_suggest';
    this.feed_status = entity.feed_status ?? 'new';
    this.feed_data = entity.feed_data ?? null;
  }

  /** Typed accessor for the message_suggest payload (null for other kinds). */
  get messageSuggest(): IMessageSuggest | null {
    if (this.kind !== 'message_suggest' || !this.feed_data) return null;
    return this.feed_data as IMessageSuggest;
  }
}
