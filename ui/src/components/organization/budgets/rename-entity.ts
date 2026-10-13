/**
 * Rename an entity the page is showing, and show the new name at once.
 *
 * The write takes seconds (2.5s on prod, over 10s on a slow staging), and the page only learns the
 * new name when the PUT answers -- so a rename looked lost until it came back. An entity is a
 * reactive proxy: assigning `name` on it marks it dirty and tells every subscriber and watched list
 * at once, so the name changes on the very next render and the save confirms it afterwards.
 *
 * Only the name is written (`{ name }`, never the whole entity): a whole-entity PUT would restate
 * fields this page never touched -- limits, filters -- from whatever the cache last held.
 *
 * If the save fails the old name goes back, unless the entity has moved on since (a push from the
 * server while we waited) -- then what is there is newer than our rollback and stays.
 */
import { dataManager, type APIEntity, type TypeId } from '@sdk';

type Named = APIEntity<never> & { name: string };

export async function renameEntity(typeId: TypeId, next: string): Promise<void> {
  const entity = dataManager.getByTypeIdFromCache<Named>(typeId);
  const previous = entity?.name;
  if (entity) entity.name = next;
  try {
    await dataManager.save(typeId, [], { name: next } as never);
  } catch (error) {
    if (entity && previous !== undefined && entity.name === next) {
      entity.name = previous;
      entity.dirty = false;
    }
    throw error;
  }
}
