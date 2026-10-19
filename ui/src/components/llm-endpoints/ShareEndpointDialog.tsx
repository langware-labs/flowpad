/**
 * Give somebody a budget to spend.
 *
 * Modelled on `ShareSandboxDialog`, which solves the same shape (share a resource by email; the
 * recipient signs in and finds it waiting). The logic lives in `share-endpoint.ts` so it can be
 * tested without rendering.
 *
 * The consequences note is not decoration. Everything else in this screen is about *limiting*
 * spend, so the one moment a person hands their money to somebody else is exactly where the
 * limits have to be restated — what the recipient may spend is this endpoint's own cap, shared
 * with everyone else who holds it, not a fresh allowance each.
 */
import type { ConversationParticipant, LLMEndpoint } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { AddressBookButton } from '@src/components/contact-picker/AddressBookButton';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { notify } from '@src/notifications';

import { pickInvitableEmails } from '@src/pages/hub-home/share-sandbox';
import { shareEndpointByEmail } from './share-endpoint';

export interface ShareEndpointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The budget being shared; `null` closes the dialog. */
  endpoint: LLMEndpoint | null;
  /** Called after at least one address was granted. */
  onShared?: () => void;
}

export function ShareEndpointDialog({ open, onOpenChange, endpoint, onShared }: ShareEndpointDialogProps) {
  const { t } = useLingui();
  // Who is signed in is ambient app state, not something each caller must remember to pass —
  // forgetting it silently disables the self-address drop and the picker's own exclusion.
  const { currentUser } = useAuth();
  const [selected, setSelected] = useState<ConversationParticipant[]>([]);
  const [busy, setBusy] = useState(false);
  // One channel for everything the sender needs to read, so there is exactly one `role="alert"`
  // on screen and no way for a stale validation message to sit beside fresh per-address results.
  const [problems, setProblems] = useState<string[]>([]);

  // A dialog reopened on a different budget must not still be showing the previous one's
  // recipients or failures — the addresses would look like they belong to this endpoint.
  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setProblems([]);
  }, [open, endpoint?.id]);

  const handleSubmit = useCallback(async () => {
    if (!endpoint) return;
    const emails = pickInvitableEmails(selected, [], currentUser?.email);
    if (emails.length === 0) {
      setProblems([t`Add someone to share with.`]);
      return;
    }
    setBusy(true);
    setProblems([]);
    // No try/catch: `shareEndpointByEmail` reports per address and always resolves.
    const { granted, failed } = await shareEndpointByEmail(endpoint, emails);
    setProblems(failed.map((f) => `${f.email} — ${f.reason}`));
    if (granted.length > 0) {
      notify.success({
        id: 'llm-endpoint-share',
        title: t`Budget shared`,
        message: t`${granted.join(', ')} can now spend ${endpoint.name}.`,
      });
      onShared?.();
    }
    // Only a clean run closes. Leaving it open with the failures listed is what lets someone
    // retry or correct an address without retyping the ones that worked.
    if (failed.length === 0) onOpenChange(false);
    setBusy(false);
  }, [endpoint, selected, currentUser?.email, onShared, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="share-endpoint-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Share {endpoint?.name || 'budget'}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>They'll get an email with a link that opens this budget.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <ContactPicker
            value={selected}
            onChange={setSelected}
            excludeUserId={currentUser?.id ?? undefined}
            disabled={busy}
            includeGroups={false}
            placeholder={t`Share by name or email…`}
            testId="share-endpoint-input"
          />
          <AddressBookButton value={selected} onChange={setSelected} excludeUserId={currentUser?.id ?? undefined} />
        </div>

        {/* What sharing money actually means, said plainly rather than left to be inferred from
            the limits panel: one pot, not one allowance each. */}
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          <Trans>
            Anyone you share with can spend this budget and see what it has cost. They draw on the same limits you do —
            not a separate allowance — and they cannot change the limits, the provider key, or share it on.
          </Trans>
        </div>

        {problems.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs text-destructive" role="alert">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={busy} data-testid="share-endpoint-submit">
            {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            <Trans>Share</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
