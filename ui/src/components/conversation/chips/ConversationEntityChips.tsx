import { Conversation, type TypeId } from '@sdk';
import { ContextEntityChip } from '../EntityChip';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey } from './keys';

interface ConversationEntityChipsProps {
  /** Conversation class instance — we drive chip rendering from
   *  ``conversation.contextEntities``. */
  conversation: Conversation;
}

/**
 * Chip row for a task-less conversation. Mirrors what `TaskChips` does for
 * task-bound flows but drives the chips from ``conversation.contextEntities``
 * — the unified getter that surfaces direct-field projections (e.g.
 * ``project_id`` → project chip) alongside the entity's explicit
 * ``_context_entities`` array.
 *
 * Adding a new entry via ``conversation.addContextEntity(typeId)`` (or by
 * setting one of the projected direct fields) automatically renders a chip on
 * next paint.
 */
export function ConversationEntityChips({ conversation }: ConversationEntityChipsProps) {
  const exclude = useChipsExclude();
  const inside = { type: Conversation.type, id: conversation.id ?? '' };
  const chips: TypeId[] = conversation.contextEntities ?? [];

  return (
    <>
      {chips.map((typeId) => {
        const key = ChipKey.forTypeId(typeId);
        if (exclude.has(key)) return null;
        return <ContextEntityChip key={key} typeId={typeId} inside={inside} />;
      })}
    </>
  );
}
