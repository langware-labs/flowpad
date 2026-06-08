import { useEffect, useMemo, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { Prompt, type TypeId } from '@sdk';
import { AttachmentType, attachmentDataString, type Attachment } from '@sdk/entities/flow-message';
import { useEntity } from '@sdk/react/hooks';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@src/components/ui/dialog';
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

interface PromptAttachmentPreviewProps {
  /** Every prompt attachment on the message — legacy PROMPT and entity-backed TYPE_ID alike. */
  attachments: Attachment[];
  /** FlowMessage id — required for legacy prompt-file download URLs. Omit in the composer preview. */
  messageId?: string;
  /** First prompt-entity TypeId — enables the entity-text fetch as a preview fallback. */
  promptEntityTypeId?: TypeId | null;
}

/**
 * The prompt CONTENT renderer for the attachment-actions row — "Prompt to
 * run:" + truncated inline text (click → merged-preview dialog) + paperclip
 * chips for legacy prompt files. Content only; the CTAs (Approve & Execute,
 * Edit, …) come from the registry and render beside this in
 * `AttachmentActionsRow`.
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
}: PromptAttachmentPreviewProps) {
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
      attachments.filter(
        (a) => a.attachment_type === AttachmentType.PROMPT && attachmentDataString(a).startsWith('prompt/'),
      ),
    [attachments],
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

  // For the dialog, also fetch each legacy prompt file's text so the merged
  // "Prompt to run" preview matches what will actually be sent to Claude.
  const [filePreviews, setFilePreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const updates: Record<string, string> = {};
      for (const a of fileAttachments) {
        const key = attachmentDataString(a);
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

  const mergedDialogText = useMemo(() => {
    const parts: string[] = [];
    if (inlineText) parts.push(inlineText);
    for (const a of fileAttachments) {
      const d = attachmentDataString(a);
      const filename = d.split('/').pop() || d;
      const body = filePreviews[d];
      if (body !== undefined) parts.push(`--- ${filename} ---\n${body}`);
      else parts.push(`--- ${filename} ---\n(content unavailable)`);
    }
    return parts.join('\n\n');
  }, [inlineText, fileAttachments, filePreviews]);

  const trimmed = inlineText ? truncate(inlineText, TRIM_LIMIT) : '';
  const hasContent = inlineText.length > 0 || fileAttachments.length > 0 || entityAttachments.length > 0;
  if (!hasContent) return null;

  return (
    <>
      <span className="shrink-0">Prompt to run:</span>

      {/* Inline text portion (if any) — click to expand. */}
      {inlineText && (
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              title="Click to view full prompt"
              className="min-w-0 max-w-full truncate rounded px-1.5 py-0.5 text-left italic text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
            >
              “{trimmed}”
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Prompt to run</DialogTitle>
            </DialogHeader>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
              {mergedDialogText || '(prompt content unavailable)'}
            </pre>
          </DialogContent>
        </Dialog>
      )}
      {!inlineText && entityAttachments.length > 0 && (
        <span className="italic text-foreground/60">(prompt content unavailable)</span>
      )}

      {/* Legacy prompt-file chips. Downloadable when we have a messageId;
          preview-only (no link) when this is the composer-queued state pre-upload. */}
      {fileAttachments.map((a) => {
        const d = attachmentDataString(a);
        const filename = d.split('/').pop() || d;
        const display = truncateMiddle(filename, FILENAME_LIMIT);
        const url = messageId ? localAttachmentUrl(messageId, a) : null;
        const className =
          'inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground';
        return url ? (
          <a
            key={d}
            href={url}
            target="_blank"
            rel="noreferrer"
            download={filename}
            title={`Download ${filename}`}
            className={className}
          >
            <Paperclip className="h-3 w-3" />
            {display}
          </a>
        ) : (
          <span key={d} className={className} title={filename}>
            <Paperclip className="h-3 w-3" />
            {display}
          </span>
        );
      })}
    </>
  );
}
