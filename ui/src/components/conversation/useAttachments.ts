import { useCallback, useState } from 'react';
import { FlowMessage, type HubClientErrorInfo } from '@sdk';
import {
  BodyStatus,
  attachmentDataString,
  type Attachment,
} from '@sdk/entities/flow-message';
import { AttachmentChipState } from './AttachmentChip';
import { isDownloadableFileAttachment, localAttachmentUrl } from './attachment-url';
import { useFlowMessageProgress, type FlowMessageProgress } from './useFlowMessageProgress';
import { useFlowMessageDownloadError } from './useFlowMessageDownloadError';

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
}

export interface UseAttachments {
  /** FILE attachments (the conversation.jsonl transcript is filtered out). */
  items: AttachmentView[];
  /** Live upload/download progress for this message, or null when idle. */
  progress: FlowMessageProgress | null;
  /** Most recent per-message download error, or null. */
  error: HubClientErrorInfo | null;
  dismissError: () => void;
  /** True while a body pull triggered via `download()` is in flight. */
  downloading: boolean;
  /** The single download entrypoint — pulls + unpacks the body via
   *  `FlowMessage.downloadAttachments()`, which is a no-op unless body_status
   *  is READY. Chips call this; they never build a download URL themselves. */
  download: () => Promise<void>;
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
  return (fm.attachment ?? [])
    .filter(isDownloadableFileAttachment)
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
      };
    });
}

/**
 * The single conversation-attachment surface. Owns the index (what each
 * attachment looks like + whether it has a live URL), the live progress/error
 * signals, and the one download entrypoint. Components render from this and
 * never build an `fs/download` URL or call `download_body` directly.
 */
export function useAttachments(
  fm: FlowMessage | null | undefined,
  messageId: string,
): UseAttachments {
  const [downloading, setDownloading] = useState(false);
  const progress = useFlowMessageProgress(messageId);
  const { error, dismiss } = useFlowMessageDownloadError(messageId);

  // Cheap to derive (a filter+map over a handful of attachments) and always
  // reflects the current fm — no memo/dep-array bookkeeping to keep in sync.
  const items = buildItems(fm, messageId);

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

  return { items, progress, error, dismissError: dismiss, downloading, download };
}
