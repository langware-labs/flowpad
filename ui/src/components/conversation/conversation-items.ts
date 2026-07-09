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

export interface SoloSendNoticeParams {
  /** ``conversation.remote === true`` — shared / hub-backed. A local-only
   *  conversation always has exactly one participant; no notice there. */
  remote: boolean;
  /** COMMUNITY rosters intentionally mask responders (a guest sees only
   *  themselves), so "1 participant" would false-positive — never notice. */
  community: boolean;
  /** ``useMembers().ready`` — the hub answered at least once. Gates the
   *  initial-load window where the roster is still unknown. */
  rosterReady: boolean;
  participants: ReadonlyArray<{ user_id?: string | null }>;
  cloudUserId: string | null;
  /** ``orderedItems.at(-1)`` — a trailing DRAFT (not sent yet) suppresses. */
  lastItem: ConversationItem | null;
  /** ``sender_id`` of the last item's FlowMessage when it is a POINTER. */
  lastMessageSenderId: string | null;
}

/**
 * True when the current user just sent a message into a shared conversation
 * where they are the ONLY remaining participant — i.e. everyone else left and
 * nobody will see the message. Pure and computed (never persisted): the
 * notice appears while the condition holds and vanishes when someone rejoins.
 */
export function shouldShowSoloSendNotice(p: SoloSendNoticeParams): boolean {
  return (
    p.remote &&
    !p.community &&
    p.rosterReady &&
    !!p.cloudUserId &&
    p.participants.length === 1 &&
    p.participants[0]?.user_id === p.cloudUserId &&
    p.lastItem?.kind === ConversationItemKind.POINTER &&
    p.lastMessageSenderId === p.cloudUserId
  );
}
