/**
 * ShareSource — entity-specific share PREP, factored out of the per-entity
 * dialogs (EntityShareDialog / AskHelpDialog / SendPlanNotificationDialog).
 *
 * A ShareSource knows how to turn "the thing being shared" into a send payload
 * (asset references + shared context + files). Plan/ask-help sources mint
 * their Spec/Task rows here, but a ShareSource does NOT create a Conversation
 * — conversation selection/creation is owned by the share screen via
 * `useSendToConversation`. This is what kills the duplicate-conversation bug:
 * prep runs once, the Conversation is chosen (existing) or created (once)
 * separately.
 *
 * `prepare()` is resolve-once: the result (including any minted Task/Spec ids)
 * is cached, so a click → error → retry reuses the same rows instead of
 * minting again — replacing the old `draftTaskRef` / `draftSpecRef` guards.
 */
import {
  AgenticProcess,
  dataManager,
  fsManager,
  Spec,
  Task,
  TypeId,
} from '@sdk';
import { loadOptionalTranscript } from '@src/components/conversation/transcript-attachment';

/** Extract the first markdown heading, falling back to the filename stem. */
export function extractPlanTitle(markdown: string, filePath: string): string {
  for (const line of markdown.split('\n')) {
    const stripped = line.replace(/^#+\s*/, '').trim();
    if (stripped) return stripped;
  }
  return filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Untitled Plan';
}

export interface SharePrepPayload {
  /** Serialized TypeIds → TYPE_ID attachments on the FlowMessage. */
  assetReferences: string[];
  /** Serialized TypeIds → shared context on both the FM and (backend-side) the
   *  conversation it lands in. */
  sharedContextEntities: string[];
  /** Optional files (e.g. a session transcript) to ride the body bundle. */
  files?: File[];
}

export interface SharePrepOptions {
  recipientEmails: string[];
  senderName?: string | null;
  /** Local user id — stamped as Task.shared_by_id so SharedTaskView renders. */
  senderId?: string | null;
  /** Conversation/Task title resolved by the dialog (typed for `requiresTitle`
   *  sources, else `defaultTitle` or the auto-title). */
  title?: string;
  projectId?: string | null;
  /** Process sources only: attach the session transcript. Default true. */
  attachTranscript?: boolean;
  /** Extra user-picked files to include. */
  files?: File[];
}

export interface ShareSource {
  /** Chip text in the dialog header. */
  label: string;
  /** Short type badge (e.g. "SESSION", "PLAN"). */
  typeLabel?: string;
  /** Default new-conversation / Task title when the source supplies one. */
  defaultTitle?: string;
  /** Prompt for a title input (ask-help, which has no underlying entity). */
  requiresTitle?: boolean;
  /** Show the file-attach UI. */
  supportsFiles?: boolean;
  /** Offer the transcript-attach toggle (AgenticProcess only). */
  isProcess?: boolean;
  prepare(opts: SharePrepOptions): Promise<SharePrepPayload>;
}

/** The Task fields every share-Task factory sets identically (title + the
 *  sender/recipient/project provenance). Spread it, then add the per-source
 *  bits (spec_type, my_process_id, shared_process_id, shared_context_entities). */
function baseTaskFields(o: SharePrepOptions, title: string): Partial<Task> {
  return {
    title: title.trim(),
    status: 'to_do',
    sender_name: o.senderName?.trim() || undefined,
    shared_by_id: o.senderId ?? undefined,
    recipient_email: o.recipientEmails[0],
    project_id: o.projectId ?? null,
  } as Partial<Task>;
}

/** Wrap a factory's prep fn with resolve-once caching. */
function resolveOnce(
  fn: (opts: SharePrepOptions) => Promise<SharePrepPayload>,
): (opts: SharePrepOptions) => Promise<SharePrepPayload> {
  let cached: SharePrepPayload | null = null;
  return async (opts) => {
    if (cached) return cached;
    cached = await fn(opts);
    return cached;
  };
}

/**
 * Plain entity/doc (markdown, whiteboard, …): rides as a TYPE_ID attachment +
 * shared context. No fork, no Task.
 */
export function genericEntityShareSource(
  typeId: TypeId,
  opts: { label?: string; typeLabel?: string } = {},
): ShareSource {
  const ref = typeId.toString();
  return {
    label: opts.label ?? ref,
    typeLabel: opts.typeLabel ?? typeId.type,
    defaultTitle: opts.label,
    prepare: resolveOnce(() =>
      Promise.resolve({
        assetReferences: [ref],
        sharedContextEntities: [ref],
      }),
    ),
  };
}

/**
 * AgenticProcess session: share the session's ClaudeTranscript
 * (``claude_session`` entity — its id IS the Claude session id). The
 * transcript rides as the TYPE_ID attachment (the message chip) and the
 * shared context carries transcript + process, so the backend's mutual
 * context linking connects process ↔ message. Optionally attaches the raw
 * transcript jsonl as a file. No fork, no Task — the transcript is the
 * shared artifact.
 */
export function agenticProcessShareSource(
  typeId: TypeId,
  opts: { label?: string; defaultTitle?: string } = {},
): ShareSource {
  return {
    label: opts.label ?? `Session ${typeId.id.slice(0, 8)}`,
    typeLabel: 'SESSION',
    defaultTitle: opts.defaultTitle ?? opts.label,
    supportsFiles: true,
    isProcess: true,
    prepare: resolveOnce(async (o) => {
      const proc = await dataManager
        .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, typeId.id))
        .catch(() => null);
      const projectPath = (proc as { workdir?: string } | null)?.workdir ?? undefined;

      let files = o.files ?? [];
      const transcript = await loadOptionalTranscript(files, {
        attach: o.attachTranscript !== false,
        proc: proc ?? undefined,
        projectPath,
      });
      files = transcript.files;

      const sessionId = proc?.session_id ?? null;
      const transcriptRef = sessionId ? `claude_session-${sessionId}` : null;
      const processRef = `${AgenticProcess.type}-${typeId.id}`;
      return {
        // The chip: the transcript when a session exists, else the process.
        assetReferences: [transcriptRef ?? processRef],
        sharedContextEntities: transcriptRef ? [transcriptRef, processRef] : [processRef],
        files: files.length > 0 ? files : undefined,
      };
    }),
  };
}

/**
 * Plan/spec share: optional fork, mint a Spec (the plan body) + a Task that
 * references it. Both ride as asset refs; the Task is the conversation's
 * shared context.
 */
export function planSpecShareSource(args: {
  title: string;
  content: string;
  processId?: string | null;
}): ShareSource {
  return {
    label: args.title,
    typeLabel: 'PLAN',
    defaultTitle: args.title,
    supportsFiles: true,
    prepare: resolveOnce(async (o) => {
      let forkedProcessId: string | null = null;
      if (args.processId) {
        const proc = await dataManager
          .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, args.processId))
          .catch(() => null);
        if (proc) {
          try {
            const forked = await proc.fork(false);
            forkedProcessId = forked.id ?? null;
          } catch (err) {
            console.warn('[shareSource:plan] pre-fork failed (non-fatal):', err);
          }
        }
      }

      const effectiveTitle = (o.title || args.title).trim();
      const spec = new Spec({
        title: effectiveTitle,
        content: args.content.trim(),
        spec_type: 'plan',
      });
      await spec.save();

      const task = new Task({
        ...baseTaskFields(o, effectiveTitle),
        spec_type: 'plan',
        my_process_id: args.processId ?? null,
        shared_context_entities: [`${Spec.type}-${spec.id}`],
      } as Partial<Task>);
      task.shared_process_id = forkedProcessId;
      await task.save();

      const taskRef = `${Task.type}-${task.id}`;
      return {
        assetReferences: [taskRef, `${Spec.type}-${spec.id}`],
        sharedContextEntities: [taskRef],
        files: o.files && o.files.length > 0 ? o.files : undefined,
      };
    }),
  };
}

/**
 * Raw file on a compute node (file browser / interactive-tab side menu): the
 * bytes ride as a FILE attachment in the body bundle — the same mechanism as
 * pasted screenshots. No entity is minted; the receiver gets the file itself.
 */
export function fileShareSource(args: {
  computeNodeTypeId: TypeId;
  absPath: string;
}): ShareSource {
  const fileName = args.absPath.split('/').pop() || args.absPath;
  return {
    label: fileName,
    typeLabel: 'FILE',
    defaultTitle: fileName,
    supportsFiles: true,
    prepare: resolveOnce(async (o) => {
      const blob = await fsManager.download(args.computeNodeTypeId, args.absPath, {
        asBlob: true,
      });
      const file = new File([blob as Blob], fileName);
      return {
        assetReferences: [],
        sharedContextEntities: [],
        files: [file, ...(o.files ?? [])],
      };
    }),
  };
}

/**
 * A source that attaches nothing — the meaning rides elsewhere (the dialog's
 * pre-filled note for a feed report, or the backend `forward` action for a
 * message clone). It only labels the share; recipients/conversation are chosen
 * in the dialog.
 */
function noAssetShareSource(label: string, typeLabel: string): ShareSource {
  return {
    label,
    typeLabel,
    defaultTitle: label,
    prepare: resolveOnce(() =>
      Promise.resolve({ assetReferences: [], sharedContextEntities: [] }),
    ),
  };
}

/**
 * Feed entry (a `flow diagnose` message-suggest): the suggested report text
 * rides as the dialog's pre-filled note; the suggested support conversation is
 * pre-selected by seeding the contacts.
 */
export function feedEntryShareSource(args: { label: string }): ShareSource {
  return noAssetShareSource(args.label, 'REPORT');
}

/**
 * Forward-a-message: the backend's `forward` action owns the packaging (it
 * clones the source FlowMessage, attachments and all). The dialog's `commit`
 * override does the POST; this source just labels the share.
 */
export function messageForwardShareSource(args: { label: string }): ShareSource {
  return noAssetShareSource(args.label, 'MESSAGE');
}

/**
 * Ask-for-help: no underlying entity. Mint a `request` Task from a typed title;
 * the recipient drives it forward by replying with a PROMPT.
 */
export function taskRequestShareSource(): ShareSource {
  return {
    label: 'Ask for help',
    typeLabel: 'REQUEST',
    requiresTitle: true,
    prepare: resolveOnce(async (o) => {
      const task = new Task({
        ...baseTaskFields(o, o.title || 'Help request'),
        spec_type: 'request',
      } as Partial<Task>);
      await task.save();

      const ref = `${Task.type}-${task.id}`;
      return { assetReferences: [ref], sharedContextEntities: [ref] };
    }),
  };
}
