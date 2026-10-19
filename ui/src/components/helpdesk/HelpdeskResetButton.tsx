import { useState } from 'react';
import { helpdeskReset } from '@sdk';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DevOnly } from '@src/components/view-mode';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Trans, useLingui } from '@lingui/react/macro';
import { Trash2 } from 'lucide-react';

/**
 * Dev-only: drop the local portal checkout so the next open re-clones it.
 *
 * Local only — the desk and its tickets live on the hub and are untouched.
 * Kept as a corner affordance in the portal header rather than a button in the
 * content flow: it is a developer tool, not part of asking for help.
 */
export function HelpdeskResetButton() {
  const { t } = useLingui();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const onReset = async () => {
    setResetting(true);
    try {
      await helpdeskReset();
      notify.success({
        title: t`Help desk files removed`,
        message: t`They will be downloaded again the next time you open the help desk.`,
      });
      setConfirmOpen(false);
    } catch (err) {
      notify.error({
        title: t`Could not remove the help desk files`,
        message: errorMessage(err, t`Please try again.`),
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    // reserve={false} so the header gap collapses outside dev mode.
    <DevOnly reserve={false}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        className="gap-1.5 text-muted-foreground hover:text-destructive"
        title={t`Delete the local help desk files (dev)`}
        data-testid="helpdesk-delete-button"
      >
        <Trash2 className="h-3.5 w-3.5" />
        <Trans>Delete</Trans>
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(o: boolean) => !o && setConfirmOpen(false)}
        title={t`Delete the local help desk files?`}
        description={t`This removes the downloaded help desk folder and its indexed entries from this machine. Nothing on the server changes, and everything is downloaded again the next time you open the help desk.`}
        confirmLabel={resetting ? t`Deleting…` : t`Delete`}
        onConfirm={() => void onReset()}
        variant="destructive"
      />
    </DevOnly>
  );
}
