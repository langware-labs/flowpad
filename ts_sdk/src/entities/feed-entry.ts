import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export type FeedStatus = 'new' | 'dismissed' | 'expired';

export interface EntityFeedData {
  type_id: string;
}

export type FeedEntryData = EntityFeedData | Record<string, unknown>;

export interface IFeedEntry<TData extends FeedEntryData = EntityFeedData> extends IEntity {
  /** Visibility lifecycle — only `new` renders in the Feed. */
  feed_status?: FeedStatus | string;
  /** Feed-management data. For normal entries this points at the rendered entity. */
  data?: TData | null;
}

@registerEntity
export class FeedEntry<TData extends FeedEntryData = EntityFeedData>
  extends APIEntity<FeedEntry<TData>>
  implements IFeedEntry<TData>
{
  feed_status?: FeedStatus | string;
  data?: TData | null;
  static type: string = 'feed_entry';

  constructor(entity: Partial<IFeedEntry<TData>> = {}) {
    super(entity);
    this.feed_status = entity.feed_status ?? 'new';
    this.data = entity.data ?? null;
  }
}
