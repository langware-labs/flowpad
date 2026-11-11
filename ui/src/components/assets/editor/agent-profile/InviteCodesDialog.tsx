import type { Agent, NewPublicInviteCode } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { FreshCodes, saveCodeNames } from './FreshCodes';
import { defaultInviteSize, MachineSizeChips } from './MachineSizeChips';

/** `CODE[, name]` lines into codes and names, paired by index. The hub checks each code and answers why one is refused. */
export function parseOwnCodes(text: string): { codes: string[]; names: string[] } {
  const codes: string[] = [];
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const [code, ...name] = line.split(',');
    if (!code.trim()) continue;
    codes.push(code.trim());
    names.push(name.join(',').trim());
  }
  return { codes, names };
}

/**
 * "Add invites": mint more codes. Each new code is shown in plaintext once, with an optional name for who it is
 * for — the hub never answers the code again; the name stays on the invite's line.
 */
export function InviteCodesDialog({
  agent,
  open,
  onOpenChange,
  onChanged,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const [count, setCount] = useState(3);
  // The owner's own codes, one `CODE[, name]` per line; empty: `count` random ones.
  const [own, setOwn] = useState('');
  const ownLines = useMemo(() => parseOwnCodes(own), [own]);
  // Every code of this batch opens a machine of this size.
  const [size, setSize] = useState(() => defaultInviteSize(agent));
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<NewPublicInviteCode[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  // The plaintext lives only as long as the dialog is open.
  useEffect(() => {
    if (!open) {
      setFresh([]);
      setNames({});
    }
  }, [open]);

  const add = async () => {
    setBusy(true);
    try {
      setFresh(await agent.addPublicCodes(count, ownLines.names, size, ownLines.codes));
      setOwn('');
      await onChanged();
    } catch (e) {
      notify.error({ title: t`Could not add codes`, message: errorMessage(e, t`The hub refused the change.`) });
    } finally {
      setBusy(false);
    }
  };

  const done = async () => {
    setBusy(true);
    try {
      await saveCodeNames(agent, fresh, names);
      await onChanged();
      onOpenChange(false);
    } catch (e) {
      notify.error({ title: t`Could not name the invites`, message: errorMessage(e, t`The hub refused the change.`) });
    } finally {
      setBusy(false);
    }
  };

  const validCount = ownLines.codes.length > 0 || (count >= 1 && count <= 100);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="invite-codes-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add invites</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Each code opens its own machine. Give one code to each user.</Trans>
          </DialogDescription>
        </DialogHeader>

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
            disabled={ownLines.codes.length > 0}
            aria-label={t`Number of codes`}
            data-testid="invite-codes-count"
          />
          <span className="text-xs">
            <Trans>codes</Trans>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void add()}
            disabled={busy || !validCount}
            data-testid="invite-codes-add"
          >
            {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            <Trans>Add</Trans>
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            <Trans>Or your own codes, one per line (CODE, name):</Trans>
          </span>
          <Textarea
            rows={3}
            className="font-mono text-xs"
            value={own}
            onChange={(e) => setOwn(e.target.value)}
            placeholder="BCDF-2345, Spare1"
            aria-label={t`Own codes`}
            data-testid="invite-codes-own"
          />
        </div>
        <div className="flex items-start gap-2">
          <span className="pt-0.5 text-xs">
            <Trans>Machine</Trans>
          </span>
          <MachineSizeChips value={size} onChange={setSize} disabled={busy} />
        </div>

        {fresh.length > 0 && (
          <>
            <FreshCodes codes={fresh} names={names} onName={(id, v) => setNames((p) => ({ ...p, [id]: v }))} />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void done()} disabled={busy} data-testid="invite-codes-done">
                <Trans>Done</Trans>
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
