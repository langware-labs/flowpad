import type { FlowMessage } from '@sdk';
import type { ConversationMessagePointer } from '@sdk/entities/conversation';

/** Discriminator for `ConversationItem`. POINTER rows resolve via the
 * conversation.jsonl pointer index; DRAFT rows are local-only `FlowMessage`s. */
export enum ConversationItemKind {
  POINTER = 'pointer',
  DRAFT = 'draft',
}

/**
 * One row in the conversation feed — either a pointer (resolved via the
 * conversation.jsonl pointer index) or a local-only draft `FlowMessage`.
 */
export type ConversationItem =
  | { kind: ConversationItemKind.POINTER; key: string; messageId: string; timestamp: string; sortAt: number }
  | { kind: ConversationItemKind.DRAFT; key: string; draft: FlowMessage; sortAt: number };

function safeTime(value: string | Date | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : fallback;
}

/**
 * Merge pointer-resolved messages with local drafts and sort by created_date.
 * Pointer rows key on the message id alone — the parent now feeds each bubble
 * its FlowMessage from a single batched live query, so there's no per-bubble
 * fetch to force-remount when a message lands.
 */
export function buildConversationItems(
  pointers: readonly ConversationMessagePointer[],
  drafts: readonly FlowMessage[],
): ConversationItem[] {
  const pointerIds = new Set<string>();
  const items: ConversationItem[] = [];
  for (const ptr of pointers) {
    pointerIds.add(ptr.id);
    items.push({
      kind: ConversationItemKind.POINTER,
      key: ptr.id,
      messageId: ptr.id,
      timestamp: ptr.ts,
      sortAt: safeTime(ptr.ts, 0),
    });
  }
  for (const draft of drafts) {
    if (draft.id && pointerIds.has(draft.id)) continue;
    items.push({
      kind: ConversationItemKind.DRAFT,
      key: `draft:${draft.id ?? ''}`,
      draft,
      sortAt: safeTime(draft.created_date, Date.now()),
    });
  }
  items.sort((a, b) => a.sortAt - b.sortAt);
  return items;
}
