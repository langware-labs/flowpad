import type { FlowMessage } from '@sdk';
import type { ConversationMessagePointer } from '@sdk/entities/conversation';
import { promptAttachmentsOf } from './attachment-actions/prompt-attachment';

/** Discriminator for `ConversationItem`. POINTER rows resolve via the
 * conversation.jsonl pointer index; DRAFT rows are local-only `FlowMessage`s;
 * SESSION_GROUP rows are a run of consecutive live-session messages collapsed
 * into one indented group (see `groupConversationItems`). */
export enum ConversationItemKind {
  POINTER = 'pointer',
  DRAFT = 'draft',
  SESSION_GROUP = 'session_group',
  THREAD_GROUP = 'thread_group',
}

/**
 * One row in the conversation feed — either a pointer (resolved via the
 * conversation.jsonl pointer index) or a local-only draft `FlowMessage`.
 */
export type ConversationItem =
  | { kind: ConversationItemKind.POINTER; key: string; messageId: string; timestamp: string; sortAt: number }
  | { kind: ConversationItemKind.DRAFT; key: string; draft: FlowMessage; sortAt: number };

/** A run of consecutive same-session messages, collapsed into one group row.
 *  `children` keep their original order; SESSION_EVENT lines render inside. */
export interface SessionGroupItem {
  kind: ConversationItemKind.SESSION_GROUP;
  key: string;
  sessionId: string;
  children: ConversationItem[];
  /** Messages carrying a runnable prompt (guest → host turns). */
  promptCount: number;
  /** Messages carrying a `prompt_completion-` attachment (host → guest replies). */
  replyCount: number;
  sortAt: number;
}

/** Every message of ONE thread, packed into a single row.
 *
 *  Deliberately NOT the consecutive-run shape `SessionGroupItem` uses. A
 *  session is a contiguous episode inside a timeline, so breaking its run on
 *  interleaved chatter is correct. A thread is not: after two threads are
 *  merged into one conversation their messages interleave in time, and
 *  "packed together" has to mean one row per thread, ordered by that thread's
 *  newest message — which is what a mail client does. */
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

export type GroupedConversationItem = ConversationItem | SessionGroupItem | ThreadGroupItem;

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
    (a) => a?.attachment_type === 'type_id' && (a.data ?? '').startsWith('prompt_completion-'),
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

/**
 * Partition consecutive same-live-session runs into SESSION_GROUP rows.
 *
 * The grouping key is `fm.remote_worker_session_id` (stamped at send time /
 * re-derived from the carrier attachment on receive). Messages whose body
 * hasn't resolved yet (`getFm` → null) and messages without a session id stay
 * flat — safe degradation for old conversations and cold live-query windows.
 * A run breaks on any non-session message, so interleaved human chatter keeps
 * its place in the timeline (inline runs, not a sticky card).
 */
export function groupConversationItems(
  items: readonly ConversationItem[],
  getFm: (id: string) => FlowMessage | null,
): GroupedConversationItem[] {
  const out: GroupedConversationItem[] = [];
  let run: SessionGroupItem | null = null;

  const flush = () => {
    if (!run) return;
    // A single-message "run" still groups — the session framing (indent +
    // chip) is what tells the reader this line ran on another machine.
    out.push(run);
    run = null;
  };

  for (const item of items) {
    const fm = itemFlowMessage(item, getFm);
    const sid = fm?.remote_worker_session_id ?? null;
    if (!sid || !fm) {
      flush();
      out.push(item);
      continue;
    }
    if (run && run.sessionId !== sid) flush();
    if (!run) {
      run = {
        kind: ConversationItemKind.SESSION_GROUP,
        key: `session:${sid}:${item.key}`,
        sessionId: sid,
        children: [],
        promptCount: 0,
        replyCount: 0,
        sortAt: item.sortAt,
      };
    }
    run.children.push(item);
    if (promptAttachmentsOf(fm).length > 0) run.promptCount += 1;
    if (messageHasPromptCompletion(fm)) run.replyCount += 1;
  }
  flush();
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
 * its thread, exactly the degradation `groupConversationItems` already makes.
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
