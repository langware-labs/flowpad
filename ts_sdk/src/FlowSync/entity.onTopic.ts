import { EventBus } from '../topics/EventBus';
import { IEntity } from '../IEntity';
import { TypeId } from '../models/TypeId';

const OP_TO_TOPIC: Record<string, string> = {
  create: 'app.entity.created',
  update: 'app.entity.updated',
  delete: 'app.entity.deleted',
};

/**
 * The entity-family bus adapter (see docs/topics.md, "legacy adapters"): the
 * entity pipeline already delivers every `data_op_msg` to this tab, so the
 * app-local bus gets its `app.entity.*` wake-ups by re-emitting at the
 * DataManager seam — zero backend change. Strictly synchronous, called AFTER
 * DataManager's own invalidation handling.
 *
 * Events are wake-ups, not proofs: gating consumers (journey awaits) confirm
 * against the store before acting.
 */
export function emitEntityTopic(typeId: TypeId, op: string, data: IEntity | null): void {
  const topic = OP_TO_TOPIC[op];
  if (!topic) return;
  EventBus.emit(topic, `${typeId.type}:${typeId.id}`, { entity: data }, { origin: 'app' });
}
