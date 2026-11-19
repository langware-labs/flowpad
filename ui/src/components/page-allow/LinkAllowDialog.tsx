import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';

/**
 * A link that would start something on this computer, from outside Flowpad: the user says yes before it
 * does. Nothing the link names has run when this shows.
 */
export function LinkAllowDialog({
  does,
  onAllow,
  onDeny,
}: {
  does: 'launch' | 'clone';
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onDeny()}>
      <DialogContent data-testid="link-allow-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Allow this link?</Trans>
          </DialogTitle>
          <DialogDescription>
            {does === 'launch' ? (
              <Trans>
                A link opened outside Flowpad wants to start an agent on a project on this computer. Allow it only if you
                expected this.
              </Trans>
            ) : (
              <Trans>
                A link opened outside Flowpad wants to download a project or task onto this computer. Allow it only if you
                expected this.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onDeny} data-testid="link-allow-deny">
            <Trans>Don’t allow</Trans>
          </Button>
          <Button onClick={onAllow} data-testid="link-allow-accept">
            <Trans>Allow</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
