import type { ComputeNode } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { AddressBookButton } from '@src/components/contact-picker/AddressBookButton';
import { notify } from '@src/notifications';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  pickInvitableEmails,
  SANDBOX_SHARE_ROLE,
  SANDBOX_TRANSFER_ROLE_TO_KEEP,
  sandboxShareLink,
  setAutoLogin,
  shareFailureText,
  shareSandboxByEmail,
} from './share-sandbox';

interface Participant {
  email?: string | null;
  name?: string | null;
  id?: string;
}

export interface ShareSandboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sandbox being shared. Only `id`/`name`/`auto_login` and the inherited
   *  APIEntity methods are read. */
  sandbox: ComputeNode | null;
  /** Whether the caller owns this box. Gates the auto-login control — the hub
   *  enforces it too; this only stops us offering a button that will 403. */
  isOwner?: boolean;
  currentUserId?: string | null;
  currentUserEmail?: string | null;
  /** Refresh the sandbox list after a share/transfer changes what's visible. */
  onShared?: () => void;
}

/**
 * "Share this sandbox" — invite by email, or hand the box over.
 *
 * The hub already does all the work (`POST <node>/members` → Invitation →
 * shadow account → role grant → email). This dialog only chooses the role, the
 * landing path, and whether the invite is a handover.
 *
 * Two facts are stated plainly in the UI rather than buried, because both are
 * irreversible-ish and neither is guessable from the word "share": a recipient
 * can DELETE the box, and ticking auto-login gives it away.
 */
export function ShareSandboxDialog({
  open,
  onOpenChange,
  sandbox,
  isOwner = false,
  currentUserId,
  currentUserEmail,
  onShared,
}: ShareSandboxDialogProps) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<Participant[]>([]);
  const [transfer, setTransfer] = useState(false);
  const [autoLogin, setAutoLoginState] = useState<boolean>(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ email: string; message: string }[]>([]);
  const [copied, setCopied] = useState(false);

  const shareLink = sandbox ? sandboxShareLink(sandbox) : '';

  const handleCopy = useCallback(async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      // Revert the affordance rather than leaving a permanent tick, which would
      // read as "this link is copied" state rather than "that click worked".
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (permissions, insecure context). The
      // input is selectable, so the user still has the link -- silently doing
      // nothing is better than an error toast over a copy button.
    }
  }, [shareLink]);

  // Reset on open so a second share never inherits the first one's state —
  // especially `transfer`, where a stale tick would give away a different box.
  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setTransfer(false);
    setAutoLoginState(sandbox?.auto_login ?? true);
    setBusy(false);
    setError(null);
    setFailures([]);
  }, [open, sandbox]);

  const handleAutoLogin = useCallback(
    async (next: boolean) => {
      if (!sandbox || !isOwner) return;
      const previous = autoLogin;
      setAutoLoginState(next); // optimistic; the control is a toggle, not a form
      try {
        const applied = await setAutoLogin(sandbox, next);
        setAutoLoginState(applied);
      } catch (err) {
        setAutoLoginState(previous);
        setError(shareFailureText(err, t`Could not change this setting`));
      }
    },
    [sandbox, isOwner, autoLogin, t],
  );

  const handleSubmit = useCallback(async () => {
    if (!sandbox) return;
    const emails = pickInvitableEmails(selected, [], currentUserEmail);
    if (emails.length === 0) {
      setError(t`Pick a contact or enter an email`);
      return;
    }
    setBusy(true);
    setError(null);
    setFailures([]);
    try {
      const outcome = await shareSandboxByEmail(sandbox, emails, {
        role: SANDBOX_SHARE_ROLE,
        transfer,
        roleToKeep: transfer ? SANDBOX_TRANSFER_ROLE_TO_KEEP : undefined,
      });
      setFailures(outcome.failed);
      if (outcome.granted.length > 0) {
        notify.success({
          title: transfer
            ? t`Handed over to ${outcome.granted.join(', ')}`
            : t`Shared with ${outcome.granted.join(', ')}`,
          message: t`They'll get an email, and the sandbox is already in their list.`,
        });
        onShared?.();
      }
      // Stay open when anything failed, so the sender can see which address and
      // retry it rather than re-deriving the list from a closed dialog.
      if (outcome.failed.length === 0) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }, [sandbox, selected, currentUserEmail, transfer, t, onOpenChange, onShared]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="share-sandbox-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Share {sandbox?.name || 'sandbox'}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>They'll get an email with a link that opens this sandbox.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <ContactPicker
            value={selected}
            onChange={setSelected}
            excludeUserId={currentUserId ?? undefined}
            disabled={busy}
            includeGroups={false}
            placeholder={t`Share by name or email…`}
            testId="share-sandbox-input"
          />
          <AddressBookButton value={selected} onChange={setSelected} excludeUserId={currentUserId ?? undefined} />
        </div>

        {/* The two things "share" does not imply. Stated, not tucked into a
            tooltip — a recipient really can destroy this box. */}
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          <Trans>Anyone you share with can open, use and delete this sandbox.</Trans>
        </div>

        {isOwner && (
          <label className="flex items-start gap-2 text-xs" data-testid="share-sandbox-auto-login">
            <Checkbox
              checked={autoLogin}
              onCheckedChange={(v) => void handleAutoLogin(v === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <span className="text-muted-foreground">
              <Trans>Auto login user — this sandbox belongs to one person.</Trans>
            </span>
          </label>
        )}

        {isOwner && (
          <label className="flex items-start gap-2 text-xs" data-testid="share-sandbox-transfer">
            <Checkbox
              checked={transfer}
              onCheckedChange={(v) => setTransfer(v === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <span className="text-muted-foreground">
              <Trans>Hand it over — they become the owner and you keep view-only access.</Trans>
            </span>
          </label>
        )}

        {/* The same URL the card's Open button uses. Safe to paste anywhere:
            it is not a bearer token -- the hub requires an authenticated
            principal with at least `admin` on the node before it attaches the
            cookie-gate secret, so a stranger following it gets a 403. Shown for
            anyone who can open the box, not only after a successful send, since
            "give me the link" is a reason to open this dialog on its own. */}
        {shareLink && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              <Trans>Or send them this link</Trans>
            </span>
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={shareLink}
                onFocus={(e) => e.currentTarget.select()}
                data-testid="share-sandbox-link"
                className="min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleCopy()}
                aria-label={t`Copy link`}
                data-testid="share-sandbox-copy"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        )}

        {failures.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs text-destructive" role="alert">
            {failures.map((f) => (
              <li key={f.email}>
                {f.email} — {f.message}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={busy} data-testid="share-sandbox-submit">
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {transfer ? <Trans>Hand over</Trans> : <Trans>Share</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ShareSandboxDialog;
