/**
 * ShareSource — entity-specific share PREP, factored out of the per-entity
 * dialogs (EntityShareDialog / SendPlanNotificationDialog).
 *
 * A ShareSource knows how to turn "the thing being shared" into a send payload
 * (asset references + shared context + files). Every entity rides as an
 * existing TYPE_ID attachment — a ShareSource NEVER mints a new entity, and it
 * does NOT create a Conversation (conversation selection/creation is owned by
 * the share screen via `useSendToConversation`). This is what kills the
 * duplicate-conversation bug: prep runs once, the Conversation is chosen
 * (existing) or created (once) separately.
 *
 * `prepare()` is resolve-once: its result is cached, so a click → error → retry
 * reuses the same payload instead of re-resolving.
 */
import {
  AgenticProcess,
  Artifact,
  dataManager,
  fsManager,
  isCompleteGitOrigin,
  TypeId,
  type ConversationSendPayload,
} from '@sdk';
import { loadOptionalTranscript } from '@src/components/conversation/transcript-attachment';

export interface SharePrepPayload {
  /** Serialized TypeIds → TYPE_ID attachments on the FlowMessage. */
  assetReferences: string[];
  /** Serialized TypeIds → shared context on both the FM and (backend-side) the
   *  conversation it lands in. */
  sharedContextEntities: string[];
  /** Optional files (e.g. a session transcript) to ride the body bundle. */
  files?: File[];
  /** Body transfer policy for this share. Defaults to copy. */
  shareConfig?: ConversationSendPayload['shareConfig'];
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
  /** Static body transfer policy for this source. */
  shareConfig?: ConversationSendPayload['shareConfig'];
  prepare(opts: SharePrepOptions): Promise<SharePrepPayload>;
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
 * Artifact share. Git-backed artifacts ride as a metadata declaration plus
 * GitOrigin; the receiver resolves the checkout from git when opening.
 */
export function artifactShareSource(
  artifact: Artifact,
  opts: { label?: string; typeLabel?: string } = {},
): ShareSource {
  const ref = artifact.typeId.toString();
  const shareConfig = isCompleteGitOrigin(artifact.git_origin)
    ? { transferMode: 'git' as const }
    : undefined;
  return {
    label: opts.label ?? artifact.displayName ?? ref,
    typeLabel: opts.typeLabel ?? artifact.artifact_type ?? Artifact.type,
    defaultTitle: opts.label ?? artifact.displayName,
    shareConfig,
    prepare: resolveOnce(() =>
      Promise.resolve({
        assetReferences: [ref],
        sharedContextEntities: [ref],
        ...(shareConfig ? { shareConfig } : {}),
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
 * A source that attaches nothing — the meaning rides elsewhere (the backend
 * `forward` action for a message clone). It only labels the share;
 * recipients/conversation are chosen in the dialog.
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
 * Forward-a-message: the backend's `forward` action owns the packaging (it
 * clones the source FlowMessage, attachments and all). The dialog's `commit`
 * override does the POST; this source just labels the share.
 */
export function messageForwardShareSource(args: { label: string }): ShareSource {
  return noAssetShareSource(args.label, 'MESSAGE');
}
