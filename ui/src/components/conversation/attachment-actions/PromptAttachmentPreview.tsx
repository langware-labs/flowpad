import { useEffect, useMemo, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { Prompt, isImagePath, type TypeId } from '@sdk';
import { AttachmentType, attachmentDataString, type Attachment } from '@sdk/entities/flow-message';
import { useEntity } from '@sdk/react/hooks';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { localAttachmentUrl } from '../attachment-url';
import { isPromptEntityAttachment } from './prompt-attachment';

const TRIM_LIMIT = 90;
const FILENAME_LIMIT = 28;

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  return oneLine.slice(0, limit - 1).trimEnd() + '…';
}

function truncateMiddle(name: string, limit: number): string {
  if (name.length <= limit) return name;
  const ext = name.lastIndexOf('.');
  if (ext > 0 && name.length - ext <= 8) {
    const head = name.slice(0, limit - (name.length - ext) - 1);
    return `${head}…${name.slice(ext)}`;
  }
  return name.slice(0, limit - 1) + '…';
}

function filenameOf(att: Attachment): string {
  const d = attachmentDataString(att);
  return d.split('/').pop() || d;
}

interface PromptAttachmentPreviewProps {
  /** Every prompt attachment on the message — legacy PROMPT and entity-backed TYPE_ID alike. */
  attachments: Attachment[];
  /** FlowMessage id — required for legacy prompt-file download URLs. Omit in the composer preview. */
  messageId?: string;
  /** First prompt-entity TypeId — enables the entity-text fetch as a preview fallback. */
  promptEntityTypeId?: TypeId | null;
  /**
   * The not-yet-sent files backing the prompt. Only the composer preview has
   * these (no `messageId`/`local_path` yet) — they let an attached image
   * thumbnail before it's uploaded. Ignored once a `messageId` exists.
   */
  pendingFiles?: File[];
}

type DialogPart = { kind: 'text'; text: string } | { kind: 'image'; url: string; filename: string };

/**
 * The prompt CONTENT renderer for the attachment-actions row — "Prompt to
 * run:" + truncated inline text (click → merged-preview dialog) + chips/thumbs
 * for legacy prompt files. Image files render as inline thumbnails (row) and
 * full pictures (dialog) instead of having their bytes decoded as text; the
 * typed prompt stays text. Content only; the CTAs (Approve & Execute, Edit, …)
 * come from the registry and render beside this in `AttachmentActionsRow`.
 *
 * Text sources per attachment generation:
 *   - entity-backed TYPE_ID: `prompt_preview` (inline copy that rides the
 *     header — readable before any body download), falling back to the
 *     fetched Prompt entity's `.text` once local.
 *   - legacy PROMPT: inline `data`, or `prompt/<file>` chips whose contents
 *     are fetched for the dialog when local bytes exist.
 */
export function PromptAttachmentPreview({
  attachments,
  messageId,
  promptEntityTypeId = null,
  pendingFiles,
}: PromptAttachmentPreviewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const entityAttachments = useMemo(() => attachments.filter(isPromptEntityAttachment), [attachments]);
  const inlineAttachments = useMemo(
    () =>
      attachments.filter((a) => {
        if (a.attachment_type !== AttachmentType.PROMPT) return false;
        const d = attachmentDataString(a);
        return d.length > 0 && !d.startsWith('prompt/');
      }),
    [attachments],
  );
  const fileAttachments = useMemo(
    () =>
      attachments.filter((a) => {
        if (a.attachment_type !== AttachmentType.PROMPT) return false;
        if (!attachmentDataString(a).startsWith('prompt/')) return false;
        // Sent messages render image prompt-files as rich image attachment chips
        // (see useAttachments); only the composer preview (no messageId) shows
        // them inline here as a thumbnail.
        if (messageId && isImagePath(filenameOf(a))) return false;
        return true;
      }),
    [attachments, messageId],
  );

  // Entity fallback: fetch the first prompt entity so a message without
  // prompt_preview (or after a library edit) still previews real text.
  const { data: promptEntity } = useEntity<Prompt>(promptEntityTypeId ?? null);

  const entityTexts = useMemo(
    () =>
      entityAttachments.map((a, i) => {
        if (a.prompt_preview) return a.prompt_preview;
        if (i === 0 && promptEntity?.text) return promptEntity.text;
        return '';
      }),
    [entityAttachments, promptEntity?.text],
  );

  // Inline text shown on the row: typed prompt(s) — entity-backed first, then
  // legacy inline. Concatenate when there are multiple (rare).
  const inlineText = [...entityTexts.filter(Boolean), ...inlineAttachments.map(attachmentDataString)].join('\n\n');

  // Object URLs for composer-preview image files (no messageId/local_path yet).
  // Keyed by filename so file attachments can look theirs up; revoked on change
  // so we don't leak blobs.
  const [objectUrls, setObjectUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (messageId || !pendingFiles || pendingFiles.length === 0) {
      setObjectUrls({});
      return;
    }
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const urls: Record<string, string> = {};
    for (const f of pendingFiles) {
      if (isImagePath(f.name)) urls[f.name] = URL.createObjectURL(f);
    }
    setObjectUrls(urls);
    return () => {
      for (const u of Object.values(urls)) URL.revokeObjectURL(u);
    };
  }, [messageId, pendingFiles]);

  // The stream/object URL for an image file attachment, or null when its bytes
  // aren't reachable yet (not-yet-downloaded sent message, or composer without
  // the backing File).
  const imageUrlFor = useMemo(() => {
    return (a: Attachment): string | null => {
      if (messageId) return localAttachmentUrl(messageId, a);
      return objectUrls[filenameOf(a)] ?? null;
    };
  }, [messageId, objectUrls]);

  // For the dialog, fetch each NON-image prompt file's text so the merged
  // "Prompt to run" preview matches what will actually be sent to Claude. Image
  // files are never fetched as text — they render as pictures.
  const [filePreviews, setFilePreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const updates: Record<string, string> = {};
      for (const a of fileAttachments) {
        const key = attachmentDataString(a);
        if (isImagePath(filenameOf(a))) continue;
        if (filePreviews[key] !== undefined) continue;
        if (!a.local_path) continue;
        try {
          const res = await fetch(a.local_path);
          if (!res.ok) continue;
          const text = await res.text();
          if (cancelled) return;
          updates[key] = text;
        } catch {
          // leave undefined — file chip still works for download.
        }
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setFilePreviews((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileAttachments, filePreviews]);

  // Dialog body: typed text as text, image files as pictures, other files as
  // labelled text blocks.
  const dialogParts = useMemo<DialogPart[]>(() => {
    const parts: DialogPart[] = [];
    if (inlineText) parts.push({ kind: 'text', text: inlineText });
    for (const a of fileAttachments) {
      const filename = filenameOf(a);
      if (isImagePath(filename)) {
        const url = imageUrlFor(a);
        if (url) parts.push({ kind: 'image', url, filename });
        else parts.push({ kind: 'text', text: `--- ${filename} ---\n(image unavailable)` });
        continue;
      }
      const body = filePreviews[attachmentDataString(a)];
      parts.push({
        kind: 'text',
        text: `--- ${filename} ---\n${body !== undefined ? body : '(content unavailable)'}`,
      });
    }
    return parts;
  }, [inlineText, fileAttachments, filePreviews, imageUrlFor]);

  const trimmed = inlineText ? truncate(inlineText, TRIM_LIMIT) : '';
  const hasContent = inlineText.length > 0 || fileAttachments.length > 0 || entityAttachments.length > 0;
  if (!hasContent) return null;

  const chipClassName =
    'inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground';

  return (
    <>
      <span className="shrink-0">Prompt to run:</span>

      {/* Inline text portion (if any) — click to expand. */}
      {inlineText && (
        <button
          type="button"
          title="Click to view full prompt"
          onClick={() => setDialogOpen(true)}
          className="min-w-0 max-w-full truncate rounded px-1.5 py-0.5 text-left italic text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
        >
          “{trimmed}”
        </button>
      )}
      {!inlineText && entityAttachments.length > 0 && (
        <span className="italic text-foreground/60">(prompt content unavailable)</span>
      )}

      {/* Legacy prompt-file attachments. Images preview as a thumbnail that
          opens the merged dialog; other files are download chips (or
          preview-only when this is the composer-queued state pre-upload). */}
      {fileAttachments.map((a, i) => {
        const filename = filenameOf(a);
        const display = truncateMiddle(filename, FILENAME_LIMIT);
        const isImage = isImagePath(filename);
        const imageUrl = isImage ? imageUrlFor(a) : null;

        if (isImage && imageUrl) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => setDialogOpen(true)}
              title={`${filename} — click to view`}
              className="shrink-0 overflow-hidden rounded border border-border bg-background transition-colors hover:border-muted-foreground/50"
            >
              <img src={imageUrl} alt={filename} className="h-9 w-9 object-cover" />
            </button>
          );
        }

        const url = messageId ? localAttachmentUrl(messageId, a) : null;
        return url ? (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noreferrer"
            download={filename}
            title={`Download ${filename}`}
            className={chipClassName}
          >
            <Paperclip className="h-3 w-3" />
            {display}
          </a>
        ) : (
          <span key={i} className={chipClassName} title={filename}>
            <Paperclip className="h-3 w-3" />
            {display}
          </span>
        );
      })}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Prompt to run</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-auto">
            {dialogParts.length === 0 && (
              <p className="text-sm italic text-muted-foreground">(prompt content unavailable)</p>
            )}
            {dialogParts.map((part, i) =>
              part.kind === 'image' ? (
                <img
                  key={i}
                  src={part.url}
                  alt={part.filename}
                  className="max-h-[50vh] max-w-full rounded-md border border-border object-contain"
                />
              ) : (
                <pre
                  key={i}
                  className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground"
                >
                  {part.text}
                </pre>
              ),
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
