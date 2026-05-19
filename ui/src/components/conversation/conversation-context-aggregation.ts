/**
 * Pure data-shaping helpers for the conversation Context panel.
 *
 * Everything here is a plain function over SDK entities — no React, no hooks,
 * no JSX. The panel component still owns the `useMemo` wrappers (memoization
 * is React's job), but the per-render *work* lives here so it can be reasoned
 * about and unit-tested in isolation.
 *
 * Aggregation invariants:
 *   - Messages are walked in conversation-pointer order, so every
 *     `originMessageIds` list is sorted earliest-first. Click-back targets
 *     consistently jump to the message that *introduced* an entity.
 *   - An entity contributed by multiple messages appears once, with every
 *     contributing message id captured in its `originMessageIds`.
 *   - Self-references (the conversation typeid itself, task processes) are
 *     stripped so the panel doesn't list "this conversation is part of its
 *     own context".
 */

import {
  AgenticProcess,
  Conversation,
  FlowMessage,
  Task,
  TypeId,
} from '@sdk';
import { AttachmentType, attachmentDataString, type Attachment } from '@sdk/entities/flow-message';

const TRANSCRIPT_FILENAME = 'conversation.jsonl';

/** Detect the `conversation.jsonl` file attachment — surfaced as its own row
 *  in Shared Context rather than as a generic file. */
export function isTranscriptAttachment(a: Attachment): boolean {
  if (a.attachment_type !== AttachmentType.FILE) return false;
  const d = attachmentDataString(a);
  return !!d && d.endsWith(TRANSCRIPT_FILENAME);
}

// ─────────────────────────────────────────────────────────────────────────
//  Row shapes
// ─────────────────────────────────────────────────────────────────────────

/** Shared origin shape — every aggregated row carries the set of FlowMessage
 *  ids that contributed it, sorted earliest-first. Used for both the per-row
 *  highlight (overlap with the selected set) and the click-back navigation. */
export interface OriginSet {
  originMessageIds: string[];
}

export interface SharedEntityAgg extends OriginSet {
  typeId: TypeId;
}

export interface TranscriptEntry extends OriginSet {
  /** The FlowMessage whose attachment this is — used to build the download
   *  URL and view affordances on the row. */
  messageId: string;
  attachment: Attachment;
}

/** A file attached to a message (either as a regular FILE or as a prompt-slot
 *  file), surfaced in Shared Context. `kind` distinguishes the two slots so
 *  the row can label them differently. Bytes live in the message's VFS — this
 *  entry is purely a view-model. */
export interface AttachmentEntry extends OriginSet {
  messageId: string;
  attachment: Attachment;
  kind: 'file' | 'prompt-file';
}

export interface PrivateTaskAgg extends OriginSet {
  task: Task;
}

export interface PrivateProcessAgg extends OriginSet {
  process: AgenticProcess;
}

// ─────────────────────────────────────────────────────────────────────────
//  Ordering + lookup primitives
// ─────────────────────────────────────────────────────────────────────────

/**
 * Walk `candidateFlowMessages` in the order the conversation's pointer list
 * records — drops drafts/strays whose ids aren't pointed at, keeps real
 * messages in jsonl order. Returns `[]` when the conversation hasn't loaded
 * yet so callers can branch on emptiness without null-guarding everywhere.
 */
export function orderMessagesByConversation(
  conversation: Conversation | null,
  candidateFlowMessages: FlowMessage[],
): FlowMessage[] {
  if (!conversation) return [];
  const order = conversation.conversationMessageIds ?? [];
  if (order.length === 0) return [];
  const byId = new Map<string, FlowMessage>();
  for (const fm of candidateFlowMessages) {
    if (fm.id) byId.set(fm.id, fm);
  }
  const out: FlowMessage[] = [];
  for (const ptr of order) {
    const fm = byId.get(ptr.id);
    if (fm) out.push(fm);
  }
  return out;
}

/** Set of FlowMessage TypeId strings for the ordered conversation — the
 *  filter Private Context items intersect against. */
export function flowMessageIdSet(orderedMessages: FlowMessage[]): Set<string> {
  const out = new Set<string>();
  for (const fm of orderedMessages) {
    if (fm.id) out.add(new TypeId(FlowMessage.type, fm.id).toString());
  }
  return out;
}

/** Things to *exclude* from Shared Context: the conversation itself, both
 *  task-side AgenticProcesses, and every FlowMessage in the thread (so a
 *  message that references itself doesn't show up as its own context row). */
export function buildSkipKeys(
  flowMessageIds: ReadonlySet<string>,
  conversationId: string,
  task: Task | null,
): Set<string> {
  const out = new Set<string>();
  for (const id of flowMessageIds) out.add(id);
  out.add(new TypeId(Conversation.type, conversationId).toString());
  if (task?.my_process_id) out.add(new TypeId(AgenticProcess.type, task.my_process_id).toString());
  if (task?.shared_process_id) out.add(new TypeId(AgenticProcess.type, task.shared_process_id).toString());
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Shared Context
// ─────────────────────────────────────────────────────────────────────────

/**
 * Aggregate Shared Context across the ordered message list. Each entity
 * appears once with the union of every message that contributed it; ids in
 * `originMessageIds` preserve conversation order so `originMessageIds[0]` is
 * always the *first* (earliest) occurrence.
 */
export function buildSharedEntities(
  orderedMessages: FlowMessage[],
  skipKeys: ReadonlySet<string>,
  conversation?: { contextEntities?: TypeId[] } | null,
): SharedEntityAgg[] {
  const byKey = new Map<string, SharedEntityAgg>();
  const pushTypeId = (t: TypeId | null, originMessageId: string | null) => {
    if (!t) return;
    const key = t.toString();
    if (skipKeys.has(key)) return;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { typeId: t, originMessageIds: [] };
      byKey.set(key, entry);
    }
    if (originMessageId && !entry.originMessageIds.includes(originMessageId)) {
      entry.originMessageIds.push(originMessageId);
    }
  };
  for (const fm of orderedMessages) {
    if (!fm.id) continue;
    for (const t of fm.contextEntities ?? []) pushTypeId(t, fm.id);
    for (const a of fm.attachment ?? []) {
      if (a.attachment_type !== AttachmentType.TYPE_ID) continue;
      try {
        pushTypeId(new TypeId(a.data), fm.id);
      } catch {
        /* malformed — skip */
      }
    }
  }
  // Conversation-level context entities (e.g. specs added via the + button)
  // surface as Shared Context with no specific origin message — they belong
  // to the whole thread, not to a single bubble.
  if (conversation) {
    for (const t of conversation.contextEntities ?? []) pushTypeId(t, null);
  }
  return Array.from(byKey.values());
}

/** Surface every `conversation.jsonl` transcript attachment in the thread as
 *  its own row. Each entry's `originMessageIds` is just the message it lives
 *  on — transcripts don't dedupe across messages. */
export function buildTranscriptEntries(orderedMessages: FlowMessage[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const fm of orderedMessages) {
    if (!fm.id) continue;
    for (const a of fm.attachment ?? []) {
      if (isTranscriptAttachment(a)) {
        out.push({ messageId: fm.id, attachment: a, originMessageIds: [fm.id] });
      }
    }
  }
  return out;
}

/** File attachments (regular + prompt-slot files) across the thread, one row
 *  per attachment. Inline-text PROMPT attachments are skipped — those are
 *  rendered by PromptApprovalRow on the message bubble, not as context rows.
 *  Transcript files are excluded (they're surfaced by `buildTranscriptEntries`
 *  separately). */
export function buildAttachmentEntries(orderedMessages: FlowMessage[]): AttachmentEntry[] {
  const out: AttachmentEntry[] = [];
  for (const fm of orderedMessages) {
    if (!fm.id) continue;
    for (const a of fm.attachment ?? []) {
      if (a.attachment_type === AttachmentType.FILE) {
        if (isTranscriptAttachment(a)) continue;
        out.push({ messageId: fm.id, attachment: a, kind: 'file', originMessageIds: [fm.id] });
      } else if (
        a.attachment_type === AttachmentType.PROMPT &&
        attachmentDataString(a).startsWith('prompt/')
      ) {
        out.push({ messageId: fm.id, attachment: a, kind: 'prompt-file', originMessageIds: [fm.id] });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Private Context
// ─────────────────────────────────────────────────────────────────────────

/** Keep only the candidate tasks that reference at least one FlowMessage in
 *  the thread, and capture every matching message id in conversation order. */
export function aggregatePrivateTasks(
  candidateTasks: Task[],
  flowMessageIds: ReadonlySet<string>,
): PrivateTaskAgg[] {
  return candidateTasks
    .map<PrivateTaskAgg | null>((t) => {
      const origins: string[] = [];
      for (const tid of t.contextEntities ?? []) {
        if (tid.type !== FlowMessage.type) continue;
        if (flowMessageIds.has(tid.toString()) && !origins.includes(tid.id)) {
          origins.push(tid.id);
        }
      }
      return origins.length > 0 ? { task: t, originMessageIds: origins } : null;
    })
    .filter((v): v is PrivateTaskAgg => v !== null);
}

/** Same shape as `aggregatePrivateTasks`, but for AgenticProcesses. */
export function aggregatePrivateProcesses(
  candidateProcesses: AgenticProcess[],
  flowMessageIds: ReadonlySet<string>,
): PrivateProcessAgg[] {
  return candidateProcesses
    .map<PrivateProcessAgg | null>((p) => {
      const origins: string[] = [];
      for (const tid of p.contextEntities ?? []) {
        if (tid.type !== FlowMessage.type) continue;
        if (flowMessageIds.has(tid.toString()) && !origins.includes(tid.id)) {
          origins.push(tid.id);
        }
      }
      return origins.length > 0 ? { process: p, originMessageIds: origins } : null;
    })
    .filter((v): v is PrivateProcessAgg => v !== null);
}

// ─────────────────────────────────────────────────────────────────────────
//  Project + TypeId helpers
// ─────────────────────────────────────────────────────────────────────────

/** Wrap the conversation's mapped project (if any) as a TypeId for the
 *  Private Context project row. Returns `null` when nothing has been
 *  mapped — neither task.project_id nor conversation.project_id is set. */
export function resolveProjectTypeId(
  task: Task | null,
  conversation: Conversation | null,
): TypeId | null {
  const pid = task?.project_id ?? conversation?.project_id ?? null;
  return pid ? new TypeId('project', pid) : null;
}

/** Flatten the aggregated private rows + mapped project into a TypeId list,
 *  in the order the prompt builders expect: project first, then tasks, then
 *  agentic processes. */
export function buildPrivateTypeIds(
  projectTypeId: TypeId | null,
  privateTasks: PrivateTaskAgg[],
  privateProcesses: PrivateProcessAgg[],
): TypeId[] {
  const out: TypeId[] = [];
  if (projectTypeId) out.push(projectTypeId);
  for (const t of privateTasks) {
    if (t.task.id) out.push(new TypeId(Task.type, t.task.id));
  }
  for (const p of privateProcesses) {
    if (p.process.id) out.push(new TypeId(AgenticProcess.type, p.process.id));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Anchor selection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pick the FlowMessage id to anchor session-spawning actions on:
 *   1. First explicitly-selected message that actually belongs to this
 *      conversation (covers the bubble-click + entity-origin-list cases).
 *   2. Otherwise the most recent message in the thread.
 *   3. `null` when the conversation is empty.
 *
 * Sessions still carry exactly one FlowMessage TypeId in `context_entities`
 * (so the new entity surfaces in the panel afterwards), so this resolver
 * is the single source of truth for which message that should be.
 */
export function resolveAnchorMessage(
  selectedMessageIds: readonly string[] | undefined,
  flowMessageIds: ReadonlySet<string>,
  orderedMessages: FlowMessage[],
): string | null {
  for (const id of selectedMessageIds ?? []) {
    if (flowMessageIds.has(new TypeId(FlowMessage.type, id).toString())) return id;
  }
  for (let i = orderedMessages.length - 1; i >= 0; i--) {
    const id = orderedMessages[i].id;
    if (id) return id;
  }
  return null;
}
