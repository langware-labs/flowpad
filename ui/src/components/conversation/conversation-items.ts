import type { FlowMessage } from '@sdk';
import type { ConversationMessagePointer } from '@sdk/entities/conversation';
import { AttachmentType, FlowMessageKind } from '@sdk/entities/flow-message';
import { promptAttachmentsOf } from './attachment-actions/prompt-attachment';

/** Discriminator for `ConversationItem`. POINTER rows resolve via the
 * conversation.jsonl pointer index; DRAFT rows are local-only `FlowMessage`s;
 * SESSION_ANCHOR rows are a live session pinned to the message that opened it
 * (see `anchorSessionItems`). */
export enum ConversationItemKind {
  POINTER = 'pointer',
  DRAFT = 'draft',
  SESSION_ANCHOR = 'session_anchor',
  THREAD_GROUP = 'thread_group',
}

/**
 * One row in the conversation feed — either a pointer (resolved via the
 * conversation.jsonl pointer index) or a local-only draft `FlowMessage`.
 */
export type ConversationItem =
  | { kind: ConversationItemKind.POINTER; key: string; messageId: string; timestamp: string; sortAt: number }
  | { kind: ConversationItemKind.DRAFT; key: string; draft: FlowMessage; sortAt: number };

/** ONE live session in the feed: the message that opened it (rendered as an
 *  ordinary bubble) plus the session card under it. Every other message of the
 *  session — follow-up prompts, replies, lifecycle lines — is hidden from the
 *  thread and lives only in the session view; the counts are their only trace. */
export interface SessionAnchorItem {
  kind: ConversationItemKind.SESSION_ANCHOR;
  key: string;
  sessionId: string;
  /** The starting message row (POINTER or DRAFT) — the card attaches under it. */
  anchor: ConversationItem;
  /** Prompt-bearing messages of this session in the window (anchor included). */
  promptCount: number;
  /** `prompt_completion` replies of this session in the window. */
  replyCount: number;
  /** The anchor's `sortAt` — the card never moves. */
  sortAt: number;
}

/** Every message of ONE thread, packed into a single row.
 *
 *  After two threads are merged into one conversation their messages
 *  interleave in time, and "packed together" has to mean one row per thread,
 *  ordered by that thread's newest message — which is what a mail client
 *  does. `anchorSessionItems` shares the map-based shape but pins a session to
 *  its OLDEST (starting) message instead. */
export interface ThreadGroupItem {
  kind: ConversationItemKind.THREAD_GROUP;
  key: string;
  threadId: string;
  /** The newest message — what the packed row renders. */
  head: ConversationItem;
  /** What the row shows: `MessageThread.message_count` when the caller has it,
   *  else how many of this thread's messages are actually loaded. */
  messageCount: number;
  /** How many of this thread's messages are in the feed window. */
  loaded: number;
  /** Whether `messageCount` came from the server rather than the window. */
  authoritative: boolean;
  sortAt: number;
}

export type GroupedConversationItem = ConversationItem | SessionAnchorItem | ThreadGroupItem;

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

function messageHasPromptCompletion(fm: FlowMessage): boolean {
  return (fm.attachment ?? []).some(
    (a) =>
      a?.attachment_type === AttachmentType.TYPE_ID &&
      (a.data ?? '').startsWith('prompt_completion-'),
  );
}

function itemFlowMessage(
  item: ConversationItem,
  getFm: (id: string) => FlowMessage | null,
): FlowMessage | null {
  if (item.kind === ConversationItemKind.DRAFT) return item.draft;
  if (item.kind === ConversationItemKind.POINTER) return getFm(item.messageId);
  return null;
}

/** Session id → the id of the message that opened it (null while the row has
 *  not synced its `starting_message_id` yet). Built from the conversation's
 *  RemoteWorkerSession rows by `useConversationSessions`. */
export type SessionAnchorIndex = ReadonlyMap<string, string | null>;

/**
 * Pin every live session to the message that opened it.
 *
 * Contract:
 *  1. A row with no session id, or whose body has not resolved (`getFm` →
 *     null), passes through unchanged, in place.
 *  2. `SESSION_EVENT` lines are dropped from the feed.
 *  3. `prompt_completion` replies are dropped; they count toward `replyCount`.
 *  4. The anchor is the message whose id is the session's
 *     `starting_message_id`; when the session row is unknown (or its
 *     starting id is null) the EARLIEST prompt-bearing message of that
 *     session stands in, so the card shows while the row is still syncing.
 *  5. Every other session message (follow-up prompts, host draft replies) is
 *     dropped; prompt-bearing ones count toward `promptCount`.
 *  6. Output preserves timeline order: a session contributes exactly one row
 *     at its anchor's `sortAt`. Interleaved human chatter splits nothing.
 *  7. Counts are window-scoped; the session view is authoritative.
 */
export function anchorSessionItems(
  items: readonly ConversationItem[],
  getFm: (id: string) => FlowMessage | null,
  anchors: SessionAnchorIndex = new Map(),
): GroupedConversationItem[] {
  // pass 1 — pick each session's anchor and tally its counts.
  const sessions = new Map<string, { anchor: ConversationItem | null; promptCount: number; replyCount: number }>();
  for (const item of items) {
    const fm = itemFlowMessage(item, getFm);
    const sid = fm?.remote_worker_session_id ?? null;
    if (!fm || !sid) continue;
    let entry = sessions.get(sid);
    if (!entry) {
      entry = { anchor: null, promptCount: 0, replyCount: 0 };
      sessions.set(sid, entry);
    }
    if (fm.kind === FlowMessageKind.SESSION_EVENT) continue;
    const isReply = messageHasPromptCompletion(fm);
    const isPrompt = !isReply && promptAttachmentsOf(fm).length > 0;
    if (isReply) entry.replyCount += 1;
    if (isPrompt) entry.promptCount += 1;
    const startingId = anchors.get(sid) ?? null;
    if (startingId) {
      if (fm.id === startingId) entry.anchor = item;
    } else if (isPrompt && entry.anchor === null) {
      entry.anchor = item; // items arrive oldest-first: first prompt wins
    }
  }
  // pass 2 — emit rows; the anchor becomes the session row, the rest vanish.
  const out: GroupedConversationItem[] = [];
  for (const item of items) {
    const fm = itemFlowMessage(item, getFm);
    const sid = fm?.remote_worker_session_id ?? null;
    if (!fm || !sid) {
      out.push(item);
      continue;
    }
    const entry = sessions.get(sid)!;
    if (entry.anchor !== item) continue;
    out.push({
      kind: ConversationItemKind.SESSION_ANCHOR,
      key: `session:${sid}`,
      sessionId: sid,
      anchor: item,
      promptCount: entry.promptCount,
      replyCount: entry.replyCount,
      sortAt: item.sortAt,
    });
  }
  return out;
}

/** The thread a feed row belongs to, or null when it has none / isn't loaded. */
export function itemThreadId(
  item: ConversationItem,
  getFm: (id: string) => FlowMessage | null,
): string | null {
  return itemFlowMessage(item, getFm)?.thread_id ?? null;
}

/**
 * Partition by `fm.thread_id` — one row per thread, ordered by each thread's
 * newest message.
 *
 * Messages with no thread id (every Flowpad-native message, and everything
 * that predates threading) pass through UNCHANGED and keep their place in the
 * timeline. So does a message whose body has not resolved yet — past the
 * conversation's 500-message window `getFm` returns null and we cannot know
 * its thread, exactly the degradation `anchorSessionItems` already makes.
 *
 * `counts` supplies the authoritative per-thread size from
 * `MessageThread.message_count`; without it the group falls back to what is
 * loaded, which undercounts a thread longer than the window.
 */
export function groupThreadItems(
  items: readonly ConversationItem[],
  getFm: (id: string) => FlowMessage | null,
  counts?: ReadonlyMap<string, number>,
): GroupedConversationItem[] {
  const groups = new Map<string, ThreadGroupItem>();
  const out: GroupedConversationItem[] = [];

  for (const item of items) {
    const threadId = itemThreadId(item, getFm);
    if (!threadId) {
      out.push(item);
      continue;
    }
    const existing = groups.get(threadId);
    if (!existing) {
      // The authoritative count when we have it. Falling back to what is
      // loaded undercounts a thread longer than the feed's window, which is
      // the honest best we can do without it.
      const authoritative = counts?.get(threadId);
      groups.set(threadId, {
        kind: ConversationItemKind.THREAD_GROUP,
        key: `thread:${threadId}`,
        threadId,
        head: item,
        messageCount: authoritative ?? 1,
        loaded: 1,
        authoritative: authoritative !== undefined,
        sortAt: item.sortAt,
      });
      out.push(groups.get(threadId)!);
      continue;
    }
    existing.loaded += 1;
    if (!existing.authoritative) existing.messageCount = existing.loaded;
    // `items` arrives oldest-first, so the last one seen is the newest — but
    // compare rather than assume, so a caller that sorts differently still
    // gets the right head.
    if (item.sortAt >= existing.head.sortAt) {
      existing.head = item;
      existing.sortAt = item.sortAt;
    }
  }

  // Re-sort: a group's position is its NEWEST message, which it only learns
  // after every child has been seen.
  return out.sort((a, b) => a.sortAt - b.sortAt);
}

export interface SoloSendNoticeParams {
  /** ``conversation.remote === true`` — shared / hub-backed. A local-only
   *  conversation always has exactly one participant; no notice there. */
  remote: boolean;
  /** HELPDESK rosters intentionally mask responders (a guest sees only
   *  themselves), so "1 participant" would false-positive — never notice. */
  helpdesk: boolean;
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
    !p.helpdesk &&
    p.rosterReady &&
    !!p.cloudUserId &&
    p.participants.length === 1 &&
    p.participants[0]?.user_id === p.cloudUserId &&
    p.lastItem?.kind === ConversationItemKind.POINTER &&
    p.lastMessageSenderId === p.cloudUserId
  );
}
