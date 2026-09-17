import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

/**
 * StreamInboxManager — the @local singleton mirroring the backend unread projection.
 *
 * `unread` is computed and published exclusively by the backend
 * (`flow_sdk/stream_inbox` reconcile); this class is a reflected cache, never the
 * origin. The frontend renders it (sidebar pip, Unread pill, OS badge) and
 * must never compute, increment, or reset it. Consume via `useStreamInboxManager()`.
 */
export interface IStreamInboxManager extends IEntity {
  unread?: number;
}

// `implements IStreamInboxManager` only checks the class; it contributes no members, so every
// field declared solely on IStreamInboxManager read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StreamInboxManager extends EntityMerge<IStreamInboxManager> {}

@registerEntity
export class StreamInboxManager extends APIEntity<StreamInboxManager> implements IStreamInboxManager {
  unread: number = 0;
  static type: string = 'stream_inbox_manager';

  constructor(entity: Partial<IStreamInboxManager> = {}) {
    super(entity);
    this.unread = entity.unread ?? 0;
  }
}
