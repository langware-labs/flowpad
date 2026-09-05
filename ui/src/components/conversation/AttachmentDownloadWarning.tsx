import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { attachmentDataString, type AttachmentReference } from '@sdk/entities/flow-message';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';

/** The backend supplies availability; this component only presents the references. */
export function AttachmentDownloadWarning({
  attachments,
  error,
  downloading = false,
  onDownload,
}: {
  attachments: AttachmentReference[];
  error?: string | null;
  downloading?: boolean;
  onDownload?: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  if (!attachments.length && !error) return null;
  const title = error ? t`Could not download` : t`Missing attachments`;
  return (
    // A popover keeps the tooltip's action reachable by mouse and keyboard.
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={title}
          data-testid="missing-attachments-warning"
          onPointerEnter={() => setOpen(true)}
          className="inline-flex items-center rounded text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-400"
        >
          <AlertTriangle className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={title}
        data-testid="attachment-download-details"
        side="top"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-auto max-w-[min(32rem,90vw)] px-3 py-2 text-xs"
      >
        <div className="font-medium">{title}</div>
        {error && <p className="mt-1 break-all text-muted-foreground">{error}</p>}
        <ul className="mt-1 space-y-1">
          {attachments.map((attachment) => (
            <li
              key={`${attachment.attachment_type}:${attachmentDataString(attachment)}`}
              className="break-all font-mono"
            >
              {attachmentDataString(attachment)}
            </li>
          ))}
        </ul>
        {onDownload && (
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            data-testid="download-again-button"
            className="mt-2 inline-flex items-center gap-1.5 rounded border px-2 py-1 text-foreground hover:bg-accent disabled:cursor-wait disabled:opacity-50"
          >
            {downloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            {downloading ? <Trans>Downloading…</Trans> : <Trans>Download again</Trans>}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
