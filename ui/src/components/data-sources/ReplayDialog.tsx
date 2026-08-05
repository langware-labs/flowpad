/**
 * Replay: re-fetch everything, or everything since a date.
 *
 * A dialog rather than two buttons because the destructive half needs saying
 * out loud: replaying drops the records and rebuilds them, and `read`/`starred`
 * are ours — they do not come back. The date is the only input, and leaving it
 * empty is the "everything" case rather than a separate verb.
 */
import { useEffect, useState } from 'react';
import type { DataSource } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
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
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';

export function ReplayDialog({
  source,
  open,
  onOpenChange,
}: {
  /** Null while closed — the view owns one dialog, not one per card. */
  source: DataSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [since, setSince] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setSince('');
  }, [open]);

  const submit = async () => {
    if (!source) return;
    setBusy(true);
    try {
      // A bare `yyyy-mm-dd` from the date input is a valid ISO date; the backend
      // reads a naive value as UTC, same as every other timestamp on the entity.
      const result = await source.replay(since || undefined);
      notify.success({
        title: since
          ? t`Dropped ${result.removed} records since ${since}`
          : t`Dropped ${result.removed} records across ${result.streams} streams`,
        // The verb is not synchronous — say when the data comes back, or the
        // empty list a user sees next looks like the replay ate everything.
        message: t`Re-fetch happens on the next poll.`,
      });
      onOpenChange(false);
    } catch (error) {
      notify.error({
        title: t`Replay failed`,
        // `errorMessage` before `instanceof Error`: an AxiosError is BOTH, and
        // its `.message` is the useless status line while the server's actual
        // explanation sits in the envelope.
        message: errorMessage(error, t`Could not replay ${source.name || source.provider}.`),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Replay {source?.name || source?.provider || ''}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Drops this source&apos;s records and clears its sync position, so the next poll
              re-reads them. Local state — read and starred — does not come back.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="replay-since">
            <Trans>Since (optional)</Trans>
          </Label>
          <Input
            id="replay-since"
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>
              Empty replays everything. With a date, only records from then on are dropped —
              undated records are kept, and the sync window is widened if it does not reach that
              far back.
            </Trans>
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={busy}>
            {busy ? '…' : since ? t`Replay since ${since}` : t`Replay everything`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
