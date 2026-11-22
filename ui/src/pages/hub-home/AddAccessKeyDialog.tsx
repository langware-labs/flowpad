import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { accessKeyFailure, registerPasskey, requestEmailCode, type AccessKey, type AccessKeyFailure } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';

const CODE_LENGTH = 6;
const CODE_INPUT_ID = 'add-access-key-code';

export interface AddAccessKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the code is sent: the signed-in person's own address. */
  email: string;
  /** The account has no access key yet: the dialog says this one is the first. */
  firstKey?: boolean;
  /** The machine request this page was opened with, if any: the new key is tied to it. */
  request?: { id: string; node: string } | null;
  onAdded: (key: AccessKey) => void;
}

/**
 * Add an access key (a passkey) to the signed-in account.
 *
 * Opening it emails a 6-digit code — every add needs one — and Continue hands over to the
 * browser's passkey prompt, then sends the new credential to the hub with the code. Every way it
 * can fail is said inline, and the dialog stays open so the person can try again.
 *
 * Only for a hub page in a real browser: the hub checks the origin the browser signed, so the
 * Electron window never opens this (`AccessKeysSection` sends it to the browser instead).
 */
export function AddAccessKeyDialog({
  open,
  onOpenChange,
  email,
  firstKey = false,
  request,
  onAdded,
}: AddAccessKeyDialogProps) {
  const { t } = useLingui();
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AccessKeyFailure | 'not_sent' | null>(null);
  // One email per opening, however many times the effect runs.
  const sentForOpen = useRef(false);

  const sendCode = async () => {
    setSending(true);
    setFailure(null);
    try {
      await requestEmailCode();
    } catch (error) {
      setFailure(accessKeyFailure(error) === 'too_many_attempts' ? 'too_many_attempts' : 'not_sent');
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!open) {
      sentForOpen.current = false;
      return;
    }
    if (sentForOpen.current) return;
    sentForOpen.current = true;
    setCode('');
    void sendCode();
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const key = await registerPasskey({ code, requestId: request?.id, requestNode: request?.node });
      onAdded(key);
      onOpenChange(false);
    } catch (error) {
      console.error('[AddAccessKeyDialog] add failed', error);
      setFailure(accessKeyFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const failureText: Record<AccessKeyFailure | 'not_sent', string> = {
    wrong_code: t`That code is wrong or has expired. Check the email and try again.`,
    too_many_attempts: t`Too many attempts. Wait a few minutes, then ask for a new code.`,
    cancelled: t`The passkey was not created. Press Continue to try again.`,
    duplicate: t`This passkey is already one of your access keys.`,
    key_limit: t`You already have 10 access keys. Remove one first.`,
    expired: t`That took too long. Press Continue to try again.`,
    forbidden: t`That machine belongs to another account. Sign in as its owner and try again.`,
    unsupported: t`A passkey cannot be created on this page. Open the Flowpad hub in your browser.`,
    unknown: t`Could not add the access key. Try again.`,
    not_sent: t`Could not send the code. Try again.`,
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-md" data-testid="add-access-key-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add access key</Trans>
          </DialogTitle>
          <DialogDescription>
            {firstKey ? (
              <Trans>
                This is the first key on your account. To check it is you, we emailed a 6-digit code to {email}.
              </Trans>
            ) : (
              <Trans>To check it is you, we emailed a 6-digit code to {email}.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === CODE_LENGTH && !busy) void submit();
          }}
        >
          <Label htmlFor={CODE_INPUT_ID}>
            <Trans>Code from the email</Trans>
          </Label>
          <Input
            id={CODE_INPUT_ID}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            disabled={busy}
            aria-invalid={failure === 'wrong_code' || undefined}
            data-testid="add-access-key-code-input"
          />
          {failure && (
            <p
              className="text-xs text-destructive"
              role="alert"
              data-testid="add-access-key-error"
              data-reason={failure}
            >
              {failureText[failure]}
            </p>
          )}
          <Button
            type="button"
            variant="link"
            className="h-auto w-fit px-0 text-xs"
            onClick={() => void sendCode()}
            disabled={sending || busy}
            data-testid="add-access-key-resend"
          >
            {sending ? <Trans>Sending the code…</Trans> : <Trans>Send a new code</Trans>}
          </Button>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={busy || code.length !== CODE_LENGTH} data-testid="add-access-key-continue">
              {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              <Trans>Continue</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
