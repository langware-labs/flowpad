import { useMemo } from 'react';
import { Conversation, type TypeId } from '@sdk';
import { ContextEntityChip } from '../EntityChip';
import { useReconcileContext } from '../useReconcileContext';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey, mergeContextBuckets } from './keys';

interface ConversationEntityChipsProps {
  /** Conversation class instance — we drive chip rendering from both
   *  ``conversation.sharedContextEntities`` and
   *  ``conversation.privateContextEntities``. */
  conversation: Conversation;
}

/**
 * Chip row for a task-less conversation. Mirrors what `TaskChips` does for
 * task-bound flows but drives the chips from the conversation's two
 * context buckets:
 *   * ``sharedContextEntities`` — wire-published thread context (e.g.
 *     specs added via the share-context endpoint).
 *   * ``privateContextEntities`` — direct-field projections (e.g.
 *     ``project_id`` → project chip) and any locally-added entries.
 *
 * Shared comes first (canonical), private follows. Deduped across buckets.
 */
export function ConversationEntityChips({ conversation }: ConversationEntityChipsProps) {
  const exclude = useChipsExclude();
  // Prune context refs whose target is gone both locally and on the hub
  // (backend-gated to local-origin holders). Fires once per conversation.
  useReconcileContext(conversation);
  const inside = useMemo(
    () => ({ type: Conversation.type, id: conversation.id ?? '' }),
    [conversation.id],
  );
  const chips = useMemo<TypeId[]>(
    () => mergeContextBuckets(conversation),
    [conversation.sharedContextEntities, conversation.privateContextEntities],
  );

  return (
    <>
      {chips.map((typeId) => {
        const key = ChipKey.forTypeId(typeId);
        if (exclude.has(key)) return null;
        return (
          <ContextEntityChip key={key} typeId={typeId} inside={inside} />
        );
      })}
    </>
  );
}
