/** Share an agent by email — modelled on `ShareEndpointDialog`; the logic is in `share-agent.ts`. */
import type { Agent, ConversationParticipant } from '@sdk';
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

import { shareAgentByEmail } from './share-agent';

export interface ShareAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
}

export function ShareAgentDialog({ open, onOpenChange, agent }: ShareAgentDialogProps) {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const [selected, setSelected] = useState<ConversationParticipant[]>([]);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setProblems([]);
  }, [open, agent.id]);

  const agentName = agent.getDisplayName() || agent.name || 'agent';

  const handleSubmit = useCallback(async () => {
    const emails = pickInvitableEmails(selected, [], currentUser?.email);
    if (emails.length === 0) {
      setProblems([t`Add someone to share with.`]);
      return;
    }
    setBusy(true);
    setProblems([]);
    // Always resolves — failures are reported per address.
    const { granted, failed } = await shareAgentByEmail(agent, emails);
    setProblems(failed.map((f) => `${f.email} — ${f.reason}`));
    if (granted.length > 0) {
      notify.success({ title: t`Shared with ${granted.join(', ')}`, message: t`They'll get an email with the agent.` });
    }
    // Stay open on any failure so the sender can correct or retry just those addresses.
    if (failed.length === 0) onOpenChange(false);
    setBusy(false);
  }, [agent, selected, currentUser?.email, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="share-agent-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Share {agentName}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>They'll get an email with a link to this agent.</Trans>
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
            testId="share-agent-input"
          />
          <AddressBookButton value={selected} onChange={setSelected} excludeUserId={currentUser?.id ?? undefined} />
        </div>

        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          <Trans>People you share with can view this agent and its files. They can't edit, deploy or share it on.</Trans>
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
          <Button onClick={() => void handleSubmit()} disabled={busy} data-testid="share-agent-submit">
            {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            <Trans>Share</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
