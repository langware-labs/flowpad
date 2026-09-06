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

import { AgenticProcess, Conversation, FlowMessage, Task, TypeId } from '@sdk';
import { AttachmentType, attachmentDataString, isAttachmentMissing, type Attachment } from '@sdk/entities/flow-message';

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
  /** Sidecar `data.path` harvested by the backend at cross-link time, when
   *  any contributing source (the conversation itself, or any FlowMessage
   *  in the thread) recorded one for this typeid. Used by the chip click
   *  to pre-warm the 404 self-heal (`?hint_path=<path>`); undefined when
   *  no source carried a path (opaque types or pre-v1.2 rows). */
  hintPath?: string;
  /** True when this entity rides in a message's body bundle (it was a TYPE_ID
   *  *attachment*, not just a context cross-link). Only downloadable entities
   *  get the "Download <type>" affordance; cross-links / conversation-level
   *  shares keep their resolve-or-open behavior. */
  downloadable?: boolean;
  /** At least one origin bundle was downloaded. Availability is separate. */
  downloaded?: boolean;
  /** Downloaded, but absent from every downloaded origin's available assets. */
  missing?: boolean;
  /** The earliest message that contributed this entity as an attachment — the
   *  one whose `downloadAttachments()` the panel triggers. */
  downloadOriginMessageId?: string;
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

/** Things to *exclude* from Shared Context: the conversation itself and
 *  every FlowMessage in the thread (so a message that references itself
 *  doesn't show up as its own context row). */
export function buildSkipKeys(flowMessageIds: ReadonlySet<string>, conversationId: string): Set<string> {
  const out = new Set<string>();
  for (const id of flowMessageIds) out.add(id);
  out.add(new TypeId(Conversation.type, conversationId).toString());
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
  conversation?: {
    sharedContextEntities?: TypeId[];
    getContextEntryData?: (t: TypeId) => Record<string, unknown> | undefined;
  } | null,
): SharedEntityAgg[] {
  const byKey = new Map<string, SharedEntityAgg>();
  /** Extract a sidecar path hint from a source's getContextEntryData(typeid).
   *  Only `data.path` strings are recognized — other types are sidecar shapes
   *  the chip pre-warm doesn't use. */
  const readHintPath = (
    source: { getContextEntryData?: (t: TypeId) => Record<string, unknown> | undefined } | null,
    typeId: TypeId,
  ): string | undefined => {
    if (!source?.getContextEntryData) return undefined;
    const data = source.getContextEntryData(typeId);
    return typeof data?.path === 'string' ? data.path : undefined;
  };
  const pushTypeId = (
    t: TypeId | null,
    originMessageId: string | null,
    sourceWithSidecar: { getContextEntryData?: (t: TypeId) => Record<string, unknown> | undefined } | null,
    fromAttachment?: { downloaded: boolean; missing: boolean },
  ) => {
    if (!t) return;
    const key = t.toString();
    if (skipKeys.has(key)) return;
    let entry = byKey.get(key);
    if (!entry) {
      // Default downloaded=true so cross-links / conversation-level shares (no
      // bundle) keep their resolve-or-open behavior; the attachment branch
      // below flips it false until the origin message's body is pulled.
      entry = { typeId: t, originMessageIds: [], downloadable: false, downloaded: true };
      byKey.set(key, entry);
    }
    if (originMessageId && !entry.originMessageIds.includes(originMessageId)) {
      entry.originMessageIds.push(originMessageId);
    }
    if (fromAttachment) {
      const wasDownloaded = !!entry.downloadable && !!entry.downloaded;
      const available = (wasDownloaded && !entry.missing) || (fromAttachment.downloaded && !fromAttachment.missing);
      entry.downloaded = wasDownloaded || fromAttachment.downloaded;
      entry.missing = entry.downloaded && !available;
      entry.downloadable = true;
      if (!entry.downloadOriginMessageId && originMessageId) {
        entry.downloadOriginMessageId = originMessageId;
      }
    }
    // First non-empty hintPath wins. Sources are walked in conversation
    // order, so we prefer the earliest harvested path.
    if (!entry.hintPath) {
      const hp = readHintPath(sourceWithSidecar, t);
      if (hp) entry.hintPath = hp;
    }
  };
  for (const fm of orderedMessages) {
    if (!fm.id) continue;
    // Walk the wire-bound shared bucket only — private is local annotation.
    for (const t of fm.sharedContextEntities ?? []) pushTypeId(t, fm.id, fm);
    for (const a of fm.attachment ?? []) {
      if (a.attachment_type !== AttachmentType.TYPE_ID) continue;
      try {
        pushTypeId(new TypeId(attachmentDataString(a)), fm.id, fm, {
          downloaded: fm.body_downloaded ?? false,
          missing: isAttachmentMissing(fm, a),
        });
      } catch {
        /* malformed — skip */
      }
    }
  }
  // Conversation-level shared context (e.g. specs published via the + button
  // through the share-context endpoint) surface as Shared Context with no
  // specific origin message — they belong to the whole thread, not to a
  // single bubble. They have no body bundle to pull, so they stay
  // downloadable=false / downloaded=true (resolve-or-open as before).
  if (conversation) {
    for (const t of conversation.sharedContextEntities ?? []) pushTypeId(t, null, conversation);
  }
  return Array.from(byKey.values());
}

/** File attachments (regular + prompt-slot files) across the thread, one row
 *  per attachment. Inline-text PROMPT attachments are skipped — those are
 *  rendered by the attachment-actions row's PromptAttachmentPreview, not as
 *  context rows.
 *
 *  No transcript exclusion: a shared session is an entity attachment now, so it
 *  is aggregated as a shared ENTITY (its own chip) and never reaches this
 *  file lane. It used to arrive as a raw FILE named `conversation.jsonl` and
 *  needed its own row type to keep it out of the file list. */
export function buildAttachmentEntries(orderedMessages: FlowMessage[]): AttachmentEntry[] {
  const out: AttachmentEntry[] = [];
  for (const fm of orderedMessages) {
    if (!fm.id) continue;
    for (const a of fm.attachment ?? []) {
      if (a.attachment_type === AttachmentType.FILE) {
        out.push({ messageId: fm.id, attachment: a, kind: 'file', originMessageIds: [fm.id] });
      } else if (a.attachment_type === AttachmentType.PROMPT && attachmentDataString(a).startsWith('prompt/')) {
        out.push({ messageId: fm.id, attachment: a, kind: 'prompt-file', originMessageIds: [fm.id] });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Private Context
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
//  Project + TypeId helpers
// ─────────────────────────────────────────────────────────────────────────

/** Wrap the conversation's mapped project (if any) as a TypeId for the
 *  Private Context project row. Returns `null` when nothing has been
 *  mapped — neither task.project_id nor conversation.project_id is set. */
export function resolveProjectTypeId(task: Task | null, conversation: Conversation | null): TypeId | null {
  const pid = task?.project_id ?? conversation?.project_id ?? null;
  return pid ? new TypeId('project', pid) : null;
}

/** Project shell for asset pointers opened from this conversation: the mapped
 *  project (task first, then conversation), else the caller's current project.
 *  Single source for the fallback chain used by attachment chips and the
 *  shared-context rows. */
export function resolveAttachmentProjectId(
  task: { project_id?: string | null } | null | undefined,
  conversation: { project_id?: string | null } | null | undefined,
  currentProjectId?: string | null,
): string | null {
  return task?.project_id ?? conversation?.project_id ?? currentProjectId ?? null;
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
