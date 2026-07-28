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
import { AgenticProcess, Artifact, dataManager, fsManager, TypeId, type ConversationSendPayload } from '@sdk';

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
  /** Offer the "Create bookmark" checkbox — the shared thing is a navigable
   *  entity the receiver could favorite (assets/artifacts, not raw files or
   *  message forwards). */
  bookmarkable?: boolean;
  /** The asset TypeId to preflight for Git-sharing eligibility. Presence gates
   *  the Share dialog's Git toggle (only asset/artifact sources set it — never
   *  sessions, forwards, collaboration invites, or raw files). The backend
   *  ``git_share_preflight`` action resolves whether this asset lives in a clean,
   *  pushed Git worktree with a usable origin; the toggle enables only when it
   *  does, and packing revalidates (never silently falls back to copy). */
  gitPreflightRef?: TypeId;
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
    bookmarkable: true,
    // File-backed assets may be shared by their Git origin — the dialog's Git
    // toggle preflights this ref; eligibility is decided backend-side.
    gitPreflightRef: typeId,
    prepare: resolveOnce(() =>
      Promise.resolve({
        assetReferences: [ref],
        sharedContextEntities: [ref],
      }),
    ),
  };
}

/**
 * Context-folder share. A folder ALWAYS travels as a Git origin the receiver
 * clones — never as copied bytes — so Git here is the POLICY, not a per-share
 * option: `shareConfig.transferMode` is pinned and `gitPreflightRef` is
 * deliberately omitted, which is what keeps the dialog's Git toggle from
 * rendering (`gitCapable` reads that ref) and keeps the conversation's
 * `git_sharing_enabled` preference out of it — mandatory isn't a preference.
 *
 * Eligibility is NOT skipped: the gate in front of the dialog preflights this
 * folder and remediates (set up git / commit + push) before the dialog ever
 * opens, and packing revalidates and fails closed.
 */
export function folderShareSource(folderTypeId: TypeId, opts: { label: string }): ShareSource {
  const ref = folderTypeId.toString();
  return {
    label: opts.label,
    typeLabel: 'FOLDER',
    defaultTitle: opts.label,
    bookmarkable: true,
    shareConfig: { transferMode: 'git' },
    prepare: resolveOnce(() =>
      Promise.resolve({
        assetReferences: [ref],
        sharedContextEntities: [ref],
      }),
    ),
  };
}

/**
 * Artifact share. When the sender opts into Git mode (the dialog's Git toggle),
 * a Git-backed artifact rides as a metadata declaration plus GitOrigin and the
 * receiver resolves the checkout from git on Download; otherwise it copies.
 * Git mode is opt-in per conversation — never auto-forced from the artifact's
 * origin — so artifacts and generic assets share one path.
 */
export function artifactShareSource(
  artifact: Artifact,
  opts: { label?: string; typeLabel?: string } = {},
): ShareSource {
  const ref = artifact.typeId.toString();
  return {
    label: opts.label ?? artifact.displayName ?? ref,
    typeLabel: opts.typeLabel ?? artifact.kind ?? Artifact.type,
    defaultTitle: opts.label ?? artifact.displayName,
    bookmarkable: true,
    // Eligibility (clean + pushed worktree with a usable origin) is resolved by
    // the backend preflight against this ref, not the artifact's cached origin.
    gitPreflightRef: artifact.typeId,
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
    prepare: resolveOnce((o) => prepareProcessTranscript(typeId, o)),
  };
}

/**
 * Resolve which session a vibe/agentic process is running.
 *
 * The frontend no longer reads or ships transcript BYTES. A session is a
 * file-backed entity, so attaching ``claude_session-<id>`` is enough — the
 * bundle packer carries the transcript from the session's own ``asset_ref``,
 * inside the session's entry, like every other file-backed asset. The browser
 * used to read the jsonl and attach it as a file named ``conversation.jsonl``,
 * a name reserved for message transport, which is why the receiver then had to
 * re-pair file↔session by searching file contents for the session id.
 *
 * Never throws: an unresolvable session comes back as `attached: false` with a
 * reason the caller can surface.
 */
export async function loadSessionTranscript(
  typeId: TypeId,
): Promise<{ sessionId?: string; attached: boolean; failureReason?: string }> {
  const proc = await dataManager
    .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, typeId.id))
    .catch(() => null);
  const sessionId = proc?.session_id ?? undefined;
  return sessionId
    ? { sessionId, attached: true }
    : { attached: false, failureReason: 'This process has no session yet.' };
}

/** Share prep for an AgenticProcess (session): the ClaudeTranscript
 *  (`claude_session-<id>`) is the chip and rides the shared context alongside
 *  the process, so the backend's mutual context linking connects the two. */
async function prepareProcessTranscript(typeId: TypeId, o: SharePrepOptions): Promise<SharePrepPayload> {
  const { sessionId } = o.attachTranscript === false ? { sessionId: undefined } : await loadSessionTranscript(typeId);

  const transcriptRef = sessionId ? `claude_session-${sessionId}` : null;
  const processRef = `${AgenticProcess.type}-${typeId.id}`;
  return {
    // The chip: the transcript when a session exists, else the process.
    assetReferences: [transcriptRef ?? processRef],
    sharedContextEntities: transcriptRef ? [transcriptRef, processRef] : [processRef],
    files: o.files?.length ? o.files : undefined,
  };
}

/**
 * Collaborate on the current vibe workspace: like {@link agenticProcessShareSource}
 * (attaches the session transcript, offers the transcript checkbox) but framed as
 * a collaboration — the user names what they want to collaborate on (`requiresTitle`).
 * When no session process is active yet (`typeId` is null), falls back to a
 * title-only invite with nothing attached, so the modal still works.
 */
export function collaborateShareSource(typeId: TypeId | null, opts: { label?: string } = {}): ShareSource {
  return {
    label: opts.label ?? 'Collaborate',
    typeLabel: 'COLLABORATE',
    requiresTitle: true,
    // A process gives us a transcript to attach (+ the checkbox); without one
    // the invite is title-only.
    ...(typeId ? { supportsFiles: true, isProcess: true } : {}),
    prepare: resolveOnce((o) =>
      typeId
        ? prepareProcessTranscript(typeId, o)
        : Promise.resolve({ assetReferences: [], sharedContextEntities: [] }),
    ),
  };
}

/**
 * Raw file on a compute node (file browser / interactive-tab side menu): the
 * bytes ride as a FILE attachment in the body bundle — the same mechanism as
 * pasted screenshots. No entity is minted; the receiver gets the file itself.
 */
export function fileShareSource(args: { computeNodeTypeId: TypeId; absPath: string }): ShareSource {
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
    prepare: resolveOnce(() => Promise.resolve({ assetReferences: [], sharedContextEntities: [] })),
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
