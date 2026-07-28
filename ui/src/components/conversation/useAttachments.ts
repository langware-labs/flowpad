import { useCallback, useState } from 'react';
import { FlowMessage, TypeId, type HubClientErrorInfo } from '@sdk';
import { AttachmentType, BodyStatus, attachmentDataString, type Attachment } from '@sdk/entities/flow-message';
import { AttachmentChipState } from './AttachmentChip';
import { isImagePromptFileAttachment, isPromptAttachment } from './attachment-actions/prompt-attachment';
import { isDownloadableFileAttachment, localAttachmentUrl } from './attachment-url';
import { useFlowMessageProgress, type FlowMessageProgress } from './useFlowMessageProgress';
import { useFlowMessageDownloadError } from './useFlowMessageDownloadError';

/** TYPE_ID attachment types the send path injects as structural self-refs —
 *  every message auto-carries ``conversation-<id>`` + ``flow_message-<id>``
 *  (the backend's own structural set in ``flow_message.summary``). Plumbing —
 *  never rendered as chips.
 *
 *  ``task`` is deliberately NOT here: the backend never auto-injects it, so a
 *  ``task`` attachment is present only when a sender explicitly attached one
 *  (assign-task flow / composer) — that's a real chip, and ``MessageEntityChip``
 *  has dedicated task-install handling for it. Do NOT re-add it: that strips
 *  every task typeid before the renderer sees it, so assigned tasks render no
 *  chip at all and ``useAttachedParentTaskIds`` becomes dead code.
 *
 *  Not to be confused with the backend's ``_NON_MATERIALIZING_TYPE_IDS``, which
 *  does list ``task`` — that gates body-download bookkeeping, not rendering. */
const STRUCTURAL_ATTACHMENT_TYPES = new Set(['conversation', 'flow_message']);

/** One downloadable attachment, resolved into everything a chip needs to render
 *  — and nothing it could use to fetch a body that isn't there. */
export interface AttachmentView {
  /** Stable React key — the attachment's VFS path. */
  key: string;
  filename: string;
  state: AttachmentChipState;
  /** Live stream URL — non-null ONLY when the bytes are local (state ===
   *  Downloaded). Every other state yields null, so a chip can never link or
   *  inline-fetch a body that was never downloaded. */
  url: string | null;
  /** Absolute on-disk path once the bytes are local (state === Downloaded),
   *  else null. This is what the editor opens — clicking a downloaded file
   *  routes to `navigation.openEditor(localPath)` (the standard file dock
   *  pointer), same as the interactive terminal's file tree. */
  localPath: string | null;
}

export interface AttachmentTypeChipView {
  key: string;
  type: string;
  label: string;
  count: number;
}

export interface UseAttachments {
  /** FILE attachments. */
  items: AttachmentView[];
  /** Non-structural TYPE_ID (entity) attachments — skill / markdown / agent /
   *  spec — as TypeIds. Rendered as entity chips once the body is
   *  downloaded; until then they ride inside the single Download button. */
  entities: TypeId[];
  /** Message-level download state, straight from the backend-derived
   *  `fm.body_downloaded`: true once the body bundle has been pulled + unpacked
   *  so every renderable attachment is local. The UI switches the whole message
   *  between the Download button and rendered chips off this one flag. */
  downloaded: boolean;
  /** True when the message carries a PROMPT attachment (the prompt row
   *  renders it). */
  hasPrompt: boolean;
  /** Count of attached assets (files + entities) — the Download button badge. */
  assetCount: number;
  /** Human labels for the Download button tooltip: entity typeids + filenames. */
  assetLabels: string[];
  /** Compact type chips rendered on the pre-download button. */
  assetTypeChips: AttachmentTypeChipView[];
  /** Live upload/download progress for this message, or null when idle. */
  progress: FlowMessageProgress | null;
  /** Most recent per-message download error, or null. */
  error: HubClientErrorInfo | null;
  dismissError: () => void;
  /** True while a body pull triggered via `download()` is in flight. */
  downloading: boolean;
  /** The single download entrypoint — pulls + unpacks the body via
   *  `FlowMessage.downloadAttachments()`, which is a no-op unless body_status
   *  is READY. Chips call this; they never build a download URL themselves.
   *  One bundle holds files AND entities, so one call materializes both. */
  download: () => Promise<void>;
}

/** Parse the non-structural TYPE_ID (entity) attachments into TypeIds. Shared
 *  by the transcript bubble and the context panel so both read one list. */
function buildEntities(fm: FlowMessage | null | undefined): TypeId[] {
  if (!fm) return [];
  return (fm.attachment ?? [])
    .filter((a) => a.attachment_type === AttachmentType.TYPE_ID)
    .map((a) => {
      const d = attachmentDataString(a);
      const dash = d.indexOf('-');
      if (dash <= 0) return null;
      return new TypeId(d.slice(0, dash), d.slice(dash + 1));
    })
    .filter((t): t is TypeId => t !== null && !STRUCTURAL_ATTACHMENT_TYPES.has(t.type));
}

/** Map one attachment to a chip state. The single truth table for "what can the
 *  user do with this attachment", replacing the inline `chipState` that used to
 *  conflate `na`-without-local-bytes with Downloaded:
 *    local_path set            → Downloaded  (bytes are on disk, openable)
 *    body UPLOADING            → Uploading   (sender still staging)
 *    body READY (not local)    → Ready       (click → download)
 *    body NA (not local)       → Unavailable (dangling pointer — no body) */
function stateFor(att: Attachment, bodyStatus: BodyStatus): AttachmentChipState {
  if (att.local_path) return AttachmentChipState.Downloaded;
  if (bodyStatus === BodyStatus.UPLOADING) return AttachmentChipState.Uploading;
  if (bodyStatus === BodyStatus.READY) return AttachmentChipState.Ready;
  return AttachmentChipState.Unavailable;
}

function buildItems(fm: FlowMessage | null | undefined, messageId: string): AttachmentView[] {
  if (!fm) return [];
  const bodyStatus = fm.body_status ?? BodyStatus.NA;
  // FILE attachments plus image prompt-files (a screenshot attached to a
  // prompt): both are downloadable bytes the recipient should see as a picture,
  // not a filename. Non-image prompt files stay in the prompt row.
  return (fm.attachment ?? [])
    .filter((a) => isDownloadableFileAttachment(a) || isImagePromptFileAttachment(a))
    .map((a) => {
      const d = attachmentDataString(a);
      const state = stateFor(a, bodyStatus);
      return {
        key: d,
        filename: d.split('/').pop() || d,
        state,
        // localAttachmentUrl is itself gated on local_path, so this is null for
        // every non-Downloaded state — belt-and-suspenders with `state`.
        url: state === AttachmentChipState.Downloaded ? localAttachmentUrl(messageId, a) : null,
        localPath: state === AttachmentChipState.Downloaded ? (a.local_path ?? null) : null,
      };
    });
}

function typeLabel(type: string): string {
  return (
    type
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Asset'
  );
}

function buildAssetTypeChips(entities: TypeId[], items: AttachmentView[]): AttachmentTypeChipView[] {
  const counts = new Map<string, number>();
  for (const entity of entities) counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
  if (items.length > 0) counts.set('file', (counts.get('file') ?? 0) + items.length);
  return Array.from(counts.entries()).map(([type, count]) => ({
    key: type,
    type,
    label: typeLabel(type),
    count,
  }));
}

/**
 * The single conversation-attachment surface. Owns the index (what each
 * attachment looks like + whether it has a live URL), the live progress/error
 * signals, and the one download entrypoint. Components render from this and
 * never build an `fs/download` URL or call `download_body` directly.
 */
export function useAttachments(fm: FlowMessage | null | undefined, messageId: string): UseAttachments {
  const [downloading, setDownloading] = useState(false);
  const progress = useFlowMessageProgress(messageId);
  const { error, dismiss } = useFlowMessageDownloadError(messageId);

  // Cheap to derive (a filter+map over a handful of attachments) and always
  // reflects the current fm — no memo/dep-array bookkeeping to keep in sync.
  const items = buildItems(fm, messageId);
  const entities = buildEntities(fm);
  const downloaded = fm?.body_downloaded ?? false;
  // Both prompt generations count: legacy PROMPT and entity-backed TYPE_ID.
  const hasPrompt = (fm?.attachment ?? []).some(isPromptAttachment);
  // The Download button badge + tooltip: one entry per attached asset
  // (entity typeids + file names) so the user sees what a pull will fetch.
  const assetLabels = [...entities.map((t) => `${t.type}-${t.id}`), ...items.map((i) => i.filename)];
  const assetCount = assetLabels.length;
  const assetTypeChips = buildAssetTypeChips(entities, items);

  const download = useCallback(async () => {
    if (!fm || downloading) return;
    setDownloading(true);
    try {
      // No-op unless body_status === READY (frontend gate #1). On success an
      // entity UPDATE fans out and the chips re-render as Downloaded; on failure
      // the error surfaces via useFlowMessageDownloadError, so swallow here.
      await fm.downloadAttachments();
    } catch {
      /* surfaced inline via the download-error hook */
    } finally {
      setDownloading(false);
    }
  }, [fm, downloading]);

  return {
    items,
    entities,
    downloaded,
    hasPrompt,
    assetCount,
    assetLabels,
    assetTypeChips,
    progress,
    error,
    dismissError: dismiss,
    downloading,
    download,
  };
}
