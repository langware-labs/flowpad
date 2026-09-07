import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import type { HubClientErrorInfo } from '@sdk';
import { attachmentDataString, BodyStatus, type AttachmentReference } from '@sdk/entities/flow-message';
import { CopyButton } from '@src/components/ui/copy-button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';

/** Everything the caller knows about WHY a pull came back short. Every field is
 *  optional — a surface that only has the reference list (the context panel)
 *  passes none and the diagnostics block simply doesn't render. */
export interface AttachmentDownloadInfo {
  /** When the message was sent — the SAME clock the bubble's header renders,
   *  never `eventTime`: that falls back to `updated_date`, which every
   *  unrelated touch of the row moves, so it would contradict the header. */
  messageTime?: string | Date | null;
  /** Hub receipt clock, when the message carries one. */
  deliveredAt?: string | Date | null;
  /** Last write to the FlowMessage row — how fresh the state above is. */
  updatedAt?: string | Date | null;
  /** Epoch ms of the last `download()` this session, or null if none ran. */
  lastAttemptAt?: number | null;
  /** Epoch ms of the last pull that returned without throwing. */
  lastSuccessAt?: number | null;
  /** How many pulls ran this session. */
  attemptCount?: number;
  /** Body-bundle lifecycle on the hub. `na` means no bundle exists at all. */
  bodyStatus?: BodyStatus | null;
  /** True once a pull completed — with missing refs it means "arrived short". */
  downloaded?: boolean;
  /** The message id, so a report can name the message the bundle belongs to. */
  messageId?: string | null;
}

function formatClock(value: string | Date | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // `formatTimeAgoShort`, not `formatTimeAgo`: the latter degrades to a bare
  // date past a week, which would just repeat the absolute stamp beside it.
  const ago = formatTimeAgoShort(date);
  const absolute = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return ago === '—' ? absolute : `${absolute} (${ago})`;
}

/**
 * A monospace value the user is expected to paste somewhere — an entity id, a
 * request path. The whole value is the copy target: these strings are UUIDs and
 * long paths that wrap across lines, so hand-selecting one is exactly what this
 * popover exists to spare the user.
 */
function CopyableValue({ value, title, testId }: { value: string; title: string; testId?: string }) {
  return (
    <CopyButton
      value={value}
      title={title}
      testId={testId}
      className="max-w-full items-start gap-1 text-start hover:text-foreground"
      iconClassName="mt-0.5 h-3 w-3 opacity-40"
      copiedIconClassName="text-emerald-500 opacity-100"
    >
      <span className="min-w-0 break-all font-mono">{value}</span>
    </CopyButton>
  );
}

/** One label/value line of the diagnostics block. `copy` marks the value as
 *  paste-worthy (an id or a path) rather than prose. */
function DetailRow({ label, value, prefix, copy }: DetailRowSpec) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 gap-1 break-all font-mono">
        {prefix && <span className="shrink-0 text-muted-foreground">{prefix}</span>}
        {copy ? <CopyableValue value={value} title={`${label} — copy`} /> : value}
      </dd>
    </div>
  );
}

interface DetailRowSpec {
  label: string;
  /** The value itself. When `copy` is set this is ALSO the copied string, so it
   *  must stay the bare id or path — anything decorative goes in `prefix`. */
  value: string;
  /** Context rendered before the value and left out of the copy (the HTTP verb). */
  prefix?: string;
  copy?: boolean;
}

/** The backend supplies availability; this component only presents the references. */
export function AttachmentDownloadWarning({
  attachments,
  error,
  info,
  downloading = false,
  onDownload,
}: {
  attachments: AttachmentReference[];
  /** The most recent download error for this message. A bare string is still
   *  accepted (callers that only have a message); the full error info also
   *  yields the status code, request and failure time. */
  error?: HubClientErrorInfo | string | null;
  info?: AttachmentDownloadInfo;
  downloading?: boolean;
  onDownload?: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  if (!attachments.length && !error) return null;
  const errorInfo = typeof error === 'string' ? null : (error ?? null);
  const errorMessage = typeof error === 'string' ? error : (errorInfo?.message ?? null);
  const title = error ? t`Could not download` : t`Missing attachments`;

  // Rows are built here (not by the caller) so every surface that shows this
  // popover reports the same facts under the same labels.
  const rows: DetailRowSpec[] = [];
  const push = (label: string, value: string | null | undefined, extra?: Omit<DetailRowSpec, 'label' | 'value'>) => {
    if (value) rows.push({ label, value, ...extra });
  };
  push(t`Message sent`, formatClock(info?.messageTime));
  push(t`Delivered`, formatClock(info?.deliveredAt));
  push(t`Record updated`, formatClock(info?.updatedAt));
  // The failure's own clock beats the attempt clock: an error can arrive from a
  // pull this session did not start (a background unpack).
  push(t`Last attempt`, formatClock(errorInfo?.ts ?? info?.lastAttemptAt));
  push(t`Last success`, formatClock(info?.lastSuccessAt));
  if (info?.attemptCount) {
    push(t`Attempts`, t`${info.attemptCount} this session`);
  }
  if (info?.bodyStatus) {
    // Why a retry can or cannot work, in the same row as the raw status.
    const status = info.bodyStatus;
    const why =
      status === BodyStatus.NA
        ? t`no bundle was ever uploaded`
        : status === BodyStatus.UPLOADING
          ? t`the sender is still staging it`
          : info.downloaded
            ? t`pulled, but arrived short`
            : t`available to pull`;
    push(t`Body status`, `${status} — ${why}`);
  }
  if (errorInfo?.statusCode) {
    push(t`HTTP status`, String(errorInfo.statusCode));
  }
  if (errorInfo?.path) {
    // The path is the copy target; the verb rides beside it as context.
    push(t`Request`, errorInfo.path, { prefix: errorInfo.method || 'GET', copy: true });
  }
  push(t`Message`, info?.messageId, { copy: true });

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
        // The title and the retry button are pinned; only the middle scrolls, so
        // a long reference list or a wide request path can never push the one
        // action in this popover out of reach.
        className="flex max-h-[min(28rem,80vh)] w-auto max-w-[min(32rem,90vw)] flex-col px-3 py-2 text-xs"
      >
        <div className="font-medium">{title}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {errorMessage && <p className="mt-1 break-all text-muted-foreground">{errorMessage}</p>}
          {attachments.length > 0 && (
            <ul className="mt-1 space-y-1">
              {attachments.map((attachment) => (
                <li key={`${attachment.attachment_type}:${attachmentDataString(attachment)}`}>
                  <CopyableValue
                    value={attachmentDataString(attachment)}
                    title={t`Copy attachment id`}
                    testId="copy-attachment-id"
                  />
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <dl
              data-testid="attachment-download-diagnostics"
              className="mt-2 space-y-0.5 border-t border-border pt-2 text-[11px] leading-relaxed"
            >
              {rows.map((row) => (
                <DetailRow key={row.label} {...row} />
              ))}
            </dl>
          )}
        </div>
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
