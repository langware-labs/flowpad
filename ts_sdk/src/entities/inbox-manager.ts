import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * InboxManager — the @local singleton mirroring the backend unread projection.
 *
 * `unread` is computed and published exclusively by the backend
 * (`flow_sdk/inbox.reconcile`); this class is a reflected cache, never the
 * origin. The frontend renders it (sidebar pip, Unread pill, OS badge) and
 * must never compute, increment, or reset it. Consume via `useInboxManager()`.
 */
export interface IInboxManager extends IEntity {
  unread?: number;
}

@registerEntity
export class InboxManager extends APIEntity<InboxManager> implements IInboxManager {
  unread: number = 0;
  static type: string = 'inbox_manager';

  constructor(entity: Partial<IInboxManager> = {}) {
    super(entity);
    this.unread = entity.unread ?? 0;
  }
}
