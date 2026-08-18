import type { ComputeNode } from '@sdk';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
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
import { isLaunched } from '@src/hooks/use-sandboxes';
import { notify } from '@src/notifications';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  pickInvitableEmails,
  SANDBOX_SHARE_ROLE,
  SANDBOX_TRANSFER_ROLE_TO_KEEP,
  sandboxShareLink,
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
  /**
   * Start this box instead of sharing it, offered when it was never launched.
   *
   * The launch itself is NOT run from here: it takes minutes, has its own
   * checklist and its own auto-login choice, and there is already a dialog that
   * does all three. This just hands the box back to the caller to open that one.
   * Omit it and the warning drops the button rather than offering a dead one.
   */
  onLaunchInstead?: () => void;
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
 *
 * A THIRD is the reason for the confirm below. Sharing a box that was never
 * launched produces a link the recipient cannot act on: `ops` is absent from
 * `compute_node`'s policy block, so it resolves through `default_policy`'s
 * `owner: ["*"]` and for nobody else — a plain share grants `admin`, which opens
 * a running box but cannot build one. The recipient follows the link, the
 * landing page tries to launch on their behalf, and the hub refuses. Nothing
 * they can do fixes it; the fix is on THIS side of the share, which is why it is
 * asked for here rather than explained there.
 */
export function ShareSandboxDialog({
  open,
  onOpenChange,
  sandbox,
  isOwner = false,
  currentUserId,
  currentUserEmail,
  onShared,
  onLaunchInstead,
}: ShareSandboxDialogProps) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<Participant[]>([]);
  const [transfer, setTransfer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ email: string; message: string }[]>([]);
  const [copied, setCopied] = useState(false);
  // The unlaunched-share confirm. Held as its own flag rather than derived, so
  // "share anyway" can go through on the second click without the condition that
  // raised it having to change.
  const [confirmUnlaunched, setConfirmUnlaunched] = useState(false);

  const shareLink = sandbox ? sandboxShareLink(sandbox) : '';
  // A box nobody ever started. `isLaunched` reads `node_provider_id`, the same
  // field the hub refuses `open-service` on, so this cannot disagree with the
  // answer the recipient will get.
  const neverLaunched = !!sandbox && !isLaunched(sandbox);

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
    setBusy(false);
    setError(null);
    setFailures([]);
    setConfirmUnlaunched(false);
  }, [open, sandbox]);

  /**
   * Send it, as a share or as a handover.
   *
   * `asTransfer` is a PARAMETER rather than the `transfer` state it usually
   * mirrors, because the confirm's "hand it over instead" has to tick the box
   * and send in one click — and a `setTransfer(true)` immediately before this
   * would not be visible to it in the same tick.
   */
  const sendShare = useCallback(
    async (emails: string[], asTransfer: boolean) => {
      if (!sandbox) return;
      setBusy(true);
      setError(null);
      setFailures([]);
      try {
        const outcome = await shareSandboxByEmail(sandbox, emails, {
          role: SANDBOX_SHARE_ROLE,
          transfer: asTransfer,
          roleToKeep: asTransfer ? SANDBOX_TRANSFER_ROLE_TO_KEEP : undefined,
        });
        setFailures(outcome.failed);
        if (outcome.granted.length > 0) {
          notify.success({
            title: asTransfer
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
    },
    [sandbox, t, onOpenChange, onShared],
  );

  const handleSubmit = useCallback(async () => {
    if (!sandbox) return;
    const emails = pickInvitableEmails(selected, [], currentUserEmail);
    if (emails.length === 0) {
      setError(t`Pick a contact or enter an email`);
      return;
    }
    // Asked AFTER the recipients are known, so an empty picker still gets the
    // ordinary "pick a contact" error rather than a warning about a share that
    // was never going to be sent.
    if (neverLaunched && !transfer) {
      setConfirmUnlaunched(true);
      return;
    }
    await sendShare(emails, transfer);
  }, [sandbox, selected, currentUserEmail, neverLaunched, transfer, t, sendShare]);

  /** One of the confirm's two ways forward. Both send; they differ in the role. */
  const confirmAnd = useCallback(
    (asTransfer: boolean) => {
      setConfirmUnlaunched(false);
      if (asTransfer) setTransfer(true);
      void sendShare(pickInvitableEmails(selected, [], currentUserEmail), asTransfer);
    },
    [selected, currentUserEmail, sendShare],
  );

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
          {/* Said here as well as in the confirm, so the tick below reads as the
              answer to a problem rather than as an unrelated extra. */}
          {neverLaunched && !transfer && (
            <p className="mt-1" data-testid="share-sandbox-unlaunched-note">
              <Trans>
                This sandbox has never been started, and only its owner can start one — so they won't be able to open it
                until you start it or hand it over.
              </Trans>
            </p>
          )}
        </div>

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
            {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            {transfer ? <Trans>Hand over</Trans> : <Trans>Share</Trans>}
          </Button>
        </DialogFooter>

        {/* The unlaunched-share confirm.
            Three ways out because there are genuinely three answers, and the two
            that fix it are the ones named first: start it (the box works for
            everyone afterwards, and you stay the owner), or hand it over (they
            become the owner and can start it themselves). "Share anyway" stays
            because a box you are ABOUT to start is a legitimate thing to share
            ahead of time — it is a warning, not a lock. */}
        <AlertDialog open={confirmUnlaunched} onOpenChange={setConfirmUnlaunched}>
          <AlertDialogContent data-testid="share-sandbox-unlaunched-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>This sandbox hasn't been started yet</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  Only a sandbox's owner can start one. If you share it as it is, they'll get the link but won't be able
                  to open it — they'll be told to ask you to start it first.
                </Trans>
              </AlertDialogDescription>
              <AlertDialogDescription>
                <Trans>Start it yourself before sharing, or hand it over so they become the owner.</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="share-sandbox-unlaunched-cancel">
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              {onLaunchInstead && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfirmUnlaunched(false);
                    onOpenChange(false);
                    onLaunchInstead();
                  }}
                  data-testid="share-sandbox-unlaunched-launch"
                >
                  <Trans>Start it first</Trans>
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => confirmAnd(false)}
                data-testid="share-sandbox-unlaunched-share-anyway"
              >
                <Trans>Share anyway</Trans>
              </Button>
              {/* Gated on the same fact as the checkbox above: only an owner can
                  confer ownership, and the hub refuses the transfer otherwise. */}
              {isOwner && (
                <Button onClick={() => confirmAnd(true)} data-testid="share-sandbox-unlaunched-handover">
                  <Trans>Hand it over</Trans>
                </Button>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

export default ShareSandboxDialog;
