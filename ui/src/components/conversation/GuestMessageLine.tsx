import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Download, FileText, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import {
  GuestFileStatus,
  GuestMessageStatus,
  getGuestMessageFile,
  getHeldGuestMessage,
  rejectGuestMessage,
  releaseGuestMessage,
  type GuestFileMeta,
  type GuestMessageMeta,
  type HeldGuestMessage,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { formatBytes } from '@src/utils/format-bytes';

/** One file of a guest message: its name and size, how screening went for it, and a download for whoever may open it. */
function GuestFileChip({
  file,
  index,
  status,
  reasons,
  conversationId,
  guestMessageId,
}: {
  file: GuestFileMeta;
  index: number;
  status?: GuestFileStatus;
  reasons?: string[];
  conversationId: string;
  guestMessageId: string;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const isImage = file.media_type.startsWith('image/');
  const note =
    status === GuestFileStatus.HELD
      ? isImage
        ? t`held — a person must release it`
        : (reasons?.[0] ?? t`held — a person must release it`)
      : status === GuestFileStatus.FLAGGED
        ? t`flagged by screening`
        : null;

  const download = async () => {
    setBusy(true);
    try {
      const got = await getGuestMessageFile(conversationId, guestMessageId, index);
      const url = URL.createObjectURL(got.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = got.name || file.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      notify.error({ title: t`Could not download the file`, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border bg-muted/20 px-2 py-1"
      data-testid="guest-message-file"
      data-status={status ?? ''}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="max-w-[16rem] truncate" title={file.name}>
        {file.name}
      </span>
      <span className="text-muted-foreground">{formatBytes(file.size)}</span>
      {note && (
        <span className="text-red-600" data-testid="guest-message-file-note">
          {note}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1"
        disabled={busy}
        onClick={() => void download()}
        aria-label={t`Download ${file.name}`}
        data-testid="guest-message-file-download"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      </Button>
    </span>
  );
}

/**
 * What the support agent wrote to a ticket's team side, as the team conversation shows it: a shield for how the
 * hub's screening went and, once it passed (or a person released it), the text. A held one hides its text behind
 * "Show text" -- fetched only then, for the person deciding -- with Release and Reject next to it.
 */
export function GuestMessageLine({
  guestMessage,
  conversationId,
  senderName,
  text,
}: {
  guestMessage: GuestMessageMeta;
  conversationId: string;
  senderName: string;
  text: string;
}) {
  const { t } = useLingui();
  const [held, setHeld] = useState<HeldGuestMessage | null>(null);
  const [busy, setBusy] = useState<'show' | 'release' | 'reject' | null>(null);
  const fail = (title: string, e: unknown) => notify.error({ title, message: errorMessage(e, ''), forceToast: true });

  const show = async () => {
    setBusy('show');
    try {
      setHeld(await getHeldGuestMessage(conversationId, guestMessage.id));
    } catch (e: unknown) {
      fail(t`Could not load the held message`, e);
    } finally {
      setBusy(null);
    }
  };
  const decide = async (verb: 'release' | 'reject') => {
    setBusy(verb);
    try {
      await (verb === 'release' ? releaseGuestMessage : rejectGuestMessage)(conversationId, guestMessage.id);
    } catch (e: unknown) {
      fail(verb === 'release' ? t`Could not release the message` : t`Could not reject the message`, e);
    } finally {
      setBusy(null);
    }
  };

  const status = guestMessage.status;
  const who = senderName || t`The support agent`;
  const reasons = guestMessage.reasons?.length ? ` — ${guestMessage.reasons.join(', ')}` : '';
  const line = {
    [GuestMessageStatus.PENDING]: {
      icon: ShieldQuestion,
      tone: 'text-muted-foreground',
      label: t`${who}: message being screened`,
    },
    [GuestMessageStatus.PASSED]: {
      icon: ShieldCheck,
      tone: 'text-emerald-600',
      label: t`${who}: message passed screening`,
    },
    [GuestMessageStatus.HELD]: {
      icon: ShieldAlert,
      tone: 'text-red-600',
      label: t`${who}: message held by screening${reasons}`,
    },
    [GuestMessageStatus.REJECTED]: { icon: ShieldX, tone: 'text-red-600', label: t`${who}: message rejected` },
  }[status];
  const Icon = line.icon;

  return (
    <div className="my-1 flex flex-col gap-1 px-2 text-xs" data-testid="guest-message-line" data-status={status}>
      <span className={`flex items-center gap-1.5 ${line.tone}`}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span data-testid="guest-message-label">{line.label}</span>
      </span>
      {status === GuestMessageStatus.PASSED && text && (
        <p
          className="whitespace-pre-wrap rounded-md border bg-muted/20 px-2 py-1.5 text-sm"
          data-testid="guest-message-text"
        >
          {text}
        </p>
      )}
      {status === GuestMessageStatus.PASSED && !!guestMessage.files?.length && (
        <div className="flex flex-wrap gap-1.5" data-testid="guest-message-files">
          {guestMessage.files.map((file, index) => (
            <GuestFileChip
              key={index}
              file={file}
              index={index}
              status={GuestFileStatus.PASSED}
              conversationId={conversationId}
              guestMessageId={guestMessage.id}
            />
          ))}
        </div>
      )}
      {status === GuestMessageStatus.HELD && (
        <div className="flex flex-col gap-1.5">
          {held ? (
            <p
              className="whitespace-pre-wrap rounded-md border border-red-500/40 bg-red-500/5 px-2 py-1.5 text-sm"
              data-testid="guest-message-held-text"
            >
              {held.text}
            </p>
          ) : (
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void show()}
                data-testid="guest-message-show"
              >
                {busy === 'show' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {t`Show text`}
              </Button>
            </div>
          )}
          {!!held?.files?.length && (
            <div className="flex flex-wrap gap-1.5" data-testid="guest-message-held-files">
              {held.files.map((file) => (
                <GuestFileChip
                  key={file.index}
                  file={file}
                  index={file.index}
                  status={file.status}
                  reasons={file.reasons}
                  conversationId={conversationId}
                  guestMessageId={guestMessage.id}
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void decide('release')}
              data-testid="guest-message-release"
            >
              {busy === 'release' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {t`Release`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void decide('reject')}
              data-testid="guest-message-reject"
            >
              {busy === 'reject' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {t`Reject`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
