import type { TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { TagInput } from './TagInput';

/**
 * One entity's tags, editable in place. Each change is the entity's `tags`
 * action; the entity takes the list the backend answers with, and every
 * subscriber of that entity re-renders from it.
 */
export function EntityTags({ typeId, className }: { typeId: TypeId; className?: string }) {
  const entity = useEntity(typeId).data;
  if (!entity) return null;
  return (
    <div className={className} data-testid="entity-tags">
      <TagInput
        tags={entity.tags ?? []}
        onAdd={(tag) => void entity.addTag(tag)}
        onRemove={(tag) => void entity.removeTag(tag)}
      />
    </div>
  );
}
