import { dataManager } from '@sdk';

/** Which way a message went, from this user's side. */
export type MessageDirection = 'sent' | 'received';

/** `sent` when this user wrote it; `received` otherwise. Null when either side is unknown yet. */
export function messageDirection(
  message: { sender_id?: string | null } | null | undefined,
  localUserId: string | null | undefined,
): MessageDirection | null {
  if (!message?.sender_id || !localUserId) return null;
  return message.sender_id === localUserId ? 'sent' : 'received';
}

/** The message icon's tag for a direction: the type's icon (backend registry) plus the role its
 *  IconSpec declares as a sub-icon (`flowpad.message.sent`). */
export function messageIconTag(direction: MessageDirection | null): string | null {
  const base = dataManager?.iconForType?.('flow_message') ?? null;
  return base && direction ? `${base}.${direction}` : base;
}
