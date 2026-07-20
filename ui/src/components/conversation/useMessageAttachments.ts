import { MessageAttachment, QueryRequest } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/**
 * Staged MessageAttachment rows for a whole conversation, indexed for chip
 * lookups. ONE query subscription per conversation panel (not per bubble):
 * unpack fires a CREATE per staged attachment and install/uninstall fire
 * UPDATEs, both of which re-emit this query and flip the chips live.
 */
export interface ConversationMessageAttachments {
  /** Attachments grouped per message id. */
  byMessage: Map<string, MessageAttachment[]>;
}

const EMPTY: ConversationMessageAttachments = { byMessage: new Map() };

export function useConversationMessageAttachments(
  conversationId: string | null | undefined,
): ConversationMessageAttachments {
  // Memoized request — useEntitiesQuery re-subscribes on identity change.
  const request = useMemo(
    () =>
      new QueryRequest({
        type: MessageAttachment.type,
        query: conversationId ? { conversation_id: conversationId } : null,
        name: 'conversation message attachments',
      }),
    [conversationId],
  );
  const { data } = useEntitiesQuery<MessageAttachment>(request, { enabled: !!conversationId });

  return useMemo(() => {
    if (!data?.length) return EMPTY;
    const byMessage = new Map<string, MessageAttachment[]>();
    for (const ma of data) {
      if (!ma.flow_message_id) continue;
      const list = byMessage.get(ma.flow_message_id) ?? [];
      list.push(ma);
      byMessage.set(ma.flow_message_id, list);
    }
    return { byMessage };
  }, [data]);
}

/** Chip-state resolution for one TYPE_ID attachment (pure — unit-tested). */
export type EntityChipDisplayState = 'installed' | 'staged' | 'hidden' | 'unavailable';

export function chipStateFor(
  entityResolved: boolean,
  ma: MessageAttachment | undefined,
  forceShow: boolean,
): EntityChipDisplayState {
  // Raw FILE rows (the OS-file-picker lane) never resolve as an entity —
  // installing copies bytes into a folder, it does not mint a resolvable
  // entity. So installed-ness comes from the MA row's own scope, and entity
  // resolution is irrelevant for them. TASK follows the same rule for the
  // opposite reason: unpack materializes a slim Task row immediately (the
  // conversation branch needs it), so entity resolution would mark a staged
  // task installed before the user ever reviewed it.
  if (ma && (ma.asset_type === 'file' || ma.asset_type === 'task')) {
    return ma.installed ? 'installed' : 'staged';
  }
  if (entityResolved) return 'installed';
  // A staged (or installed-but-not-yet-synced) attachment renders as staged
  // until the asset entity actually resolves locally.
  if (ma) return 'staged';
  if (!forceShow) return 'hidden';
  return 'unavailable';
}
