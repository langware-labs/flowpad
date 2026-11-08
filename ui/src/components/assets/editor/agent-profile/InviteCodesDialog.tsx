import type { Agent, NewPublicInviteCode, PublicInviteCode } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { CopyButton } from '@src/components/ui/copy-button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * The agent's invite codes: each listed by its last four characters only. New codes are shown in plaintext
 * once, right after they are added — the hub never answers them again.
 */
export function InviteCodesDialog({
  agent,
  open,
  onOpenChange,
  codes,
  onChanged,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  codes: PublicInviteCode[];
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<NewPublicInviteCode[]>([]);
  const [revoking, setRevoking] = useState<PublicInviteCode | null>(null);

  // The plaintext lives only as long as the dialog is open.
  useEffect(() => {
    if (!open) setFresh([]);
  }, [open]);

  const add = async () => {
    setBusy(true);
    try {
      setFresh(await agent.addPublicCodes(count));
      await onChanged();
    } catch (e) {
      notify.error({ title: t`Could not add codes`, message: errorMessage(e, t`The hub refused the change.`) });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: PublicInviteCode) => {
    try {
      await agent.revokePublicCode(code.id);
      await onChanged();
    } catch (e) {
      notify.error({ title: t`Could not revoke the code`, message: errorMessage(e, t`The hub refused the change.`) });
    }
  };

  const stateLabel = (state: PublicInviteCode['state']) =>
    state === 'in_use' ? t`In use` : state === 'revoked' ? t`Revoked` : t`Not used yet`;
  const revokingLast4 = revoking?.last4 ?? '';
  const validCount = count >= 1 && count <= 100;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="invite-codes-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Invite codes</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Each code opens its own sandbox. Give one code to each visitor.</Trans>
          </DialogDescription>
        </DialogHeader>

        {fresh.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3" data-testid="invite-codes-new">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-medium">
                <Trans>Copy them now — they won't be shown again.</Trans>
              </p>
              <CopyButton
                value={fresh.map((c) => c.code).join('\n')}
                label={<Trans>Copy all</Trans>}
                testId="invite-codes-copy-all"
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
              />
            </div>
            <ul className="space-y-0.5 font-mono text-sm">
              {fresh.map((c) => (
                <li key={c.id}>{c.code}</li>
              ))}
            </ul>
          </div>
        )}

        <ul
          className="max-h-64 divide-y overflow-y-auto rounded-md border border-border"
          data-testid="invite-codes-list"
        >
          {codes.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              <Trans>No codes yet.</Trans>
            </li>
          )}
          {codes.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-xs" data-testid="invite-code-row">
              <span className="font-mono">••••{c.last4}</span>
              <span className="flex-1 text-muted-foreground">{stateLabel(c.state)}</span>
              {c.state !== 'revoked' && (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setRevoking(c)}>
                  <Trans>Revoke</Trans>
                </Button>
              )}
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <span className="text-xs">
            <Trans>Add</Trans>
          </span>
          <Input
            type="number"
            min={1}
            max={100}
            className="h-8 w-20 text-xs"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            aria-label={t`Number of codes`}
            data-testid="invite-codes-count"
          />
          <span className="text-xs">
            <Trans>codes</Trans>
          </span>
          <Button size="sm" onClick={() => void add()} disabled={busy || !validCount} data-testid="invite-codes-add">
            {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            <Trans>Add</Trans>
          </Button>
        </div>

        <ConfirmDialog
          open={revoking !== null}
          onOpenChange={(o) => !o && setRevoking(null)}
          title={t`Revoke code`}
          description={t`Revoke code ••••${revokingLast4}? Its sandbox is deleted and the code stops working.`}
          confirmLabel={t`Revoke`}
          cancelLabel={t`Cancel`}
          variant="destructive"
          onConfirm={() => revoking && void revoke(revoking)}
          testId="invite-code-revoke"
        />
      </DialogContent>
    </Dialog>
  );
}
