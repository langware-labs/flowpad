import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Eye, Paperclip, Pencil, Play } from 'lucide-react';
import { attachmentDataString, type Attachment } from '@sdk/entities/flow-message';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@src/components/ui/dialog';
import { fileAttachmentUrl } from './attachment-url';

interface PromptApprovalRowProps {
  /** Every PROMPT attachment on the message — the row splits inline text from prompt files. */
  attachments: Attachment[];
  /** FlowMessage id — required so prompt-file chips can build a download URL. Omit for the composer preview where files aren't uploaded yet. */
  messageId?: string;
  /** Show the Approve & Execute CTA (initiator, prompt unapproved). Disappears once approved. */
  onApprove?: () => void;
  /** Show the Implement Plan CTA. Sits alongside Approve in the same row so the
   *  spec/PROMPT combo lands on one line. Independent of prompt presence — the
   *  row renders for this chip alone when there's no PROMPT attachment.
   *  Suppressed once `onOpenPlanSession` is set (a session already exists). */
  onImplementPlan?: () => void;
  /** When a plan-implementation session already exists, the row renders an
   *  "Open Plan Implementation Session" text+link affordance in the same slot
   *  the Implement Plan chip would have occupied. Mutually exclusive with
   *  `onImplementPlan` — callers should pass one or the other. */
  onOpenPlanSession?: () => void;
  /** Open the spec's markdown in an editable Milkdown view. Rendered as a
   *  small neutral pill (Eye icon) next to the Implement Plan / Open Session
   *  affordance. Independent of session state — visible whenever the bubble
   *  carries a spec. */
  onViewPlan?: () => void;
  /** Show an Edit CTA (sender, message not sent yet — composer preview). */
  onEdit?: () => void;
}

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

export function PromptApprovalRow({
  attachments,
  messageId,
  onApprove,
  onImplementPlan,
  onOpenPlanSession,
  onViewPlan,
  onEdit,
}: PromptApprovalRowProps) {
  const inlineAttachments = useMemo(
    () =>
      attachments.filter((a) => {
        const d = attachmentDataString(a);
        return d.length > 0 && !d.startsWith('prompt/');
      }),
    [attachments],
  );
  const fileAttachments = useMemo(
    () => attachments.filter((a) => attachmentDataString(a).startsWith('prompt/')),
    [attachments],
  );

  // Inline text is the user's typed prompt. Concatenate when there are
  // multiple (very rare — usually 0 or 1).
  const inlineText = inlineAttachments.map(attachmentDataString).join('\n\n');

  // For the dialog, also fetch each prompt file's text so the merged "Prompt
  // to run" preview matches what will actually be sent to Claude.
  const [filePreviews, setFilePreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
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

  // The row hosts whichever combination of CTAs the message warrants. Bail
  // when there's literally nothing to show so we don't render an empty bar
  // under every message.
  const hasPromptContent = inlineAttachments.length > 0 || fileAttachments.length > 0;
  if (!hasPromptContent && !onApprove && !onImplementPlan && !onOpenPlanSession && !onViewPlan && !onEdit) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[12px] text-muted-foreground">
      {hasPromptContent && <span className="shrink-0">Prompt to run:</span>}

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

      {/* Prompt-file chips. Downloadable when we have a messageId; preview-only
          (no link) when this is the composer-queued state pre-upload. */}
      {fileAttachments.map((a) => {
        const d = attachmentDataString(a);
        const filename = d.split('/').pop() || d;
        const display = truncateMiddle(filename, FILENAME_LIMIT);
        const url = messageId ? fileAttachmentUrl(messageId, d) : undefined;
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

      {onApprove && (
        <button
          type="button"
          onClick={onApprove}
          title="Approve this prompt and run it in the shared session"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/60 bg-emerald-500/15 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300"
        >
          <Play className="h-3 w-3" />
          Approve & Execute
        </button>
      )}
      {onViewPlan && (
        <button
          type="button"
          onClick={onViewPlan}
          title="Open the spec in the Milkdown editor"
          data-testid="message-bubble-view-plan"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-blue-400/40 bg-blue-500/10 px-2.5 text-xs font-medium text-blue-400 transition-colors hover:border-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
        >
          <Eye className="h-3 w-3" />
          View Plan
        </button>
      )}
      {onOpenPlanSession ? (
        <button
          type="button"
          onClick={onOpenPlanSession}
          title="Open the plan-implementation session already started in this conversation"
          data-testid="message-bubble-open-plan-session"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Open Plan Implementation Session
          <ExternalLink className="h-3 w-3" />
        </button>
      ) : onImplementPlan ? (
        <button
          type="button"
          onClick={onImplementPlan}
          title="Start a Claude Code session pre-loaded with this plan and the conversation context"
          data-testid="message-bubble-implement-plan"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/60 bg-emerald-500/15 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300"
        >
          <Play className="h-3 w-3" />
          Implement Plan
        </button>
      ) : null}
      {!onApprove && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      )}
    </div>
  );
}
