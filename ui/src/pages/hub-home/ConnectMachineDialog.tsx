import { CopyableCommand } from '@src/components/version-popover/version-popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Trans } from '@lingui/react/macro';

const CONNECT_COMMAND = 'flow connect';

interface ConnectMachineDialogProps {
  /** Where to run it — the machine's hostname, or its card name. Null when closed. */
  where: string | null;
  onOpenChange: (open: boolean) => void;
}

/** What to run, and where, for a machine the hub cannot wake: only the machine itself dials back. */
export function ConnectMachineDialog({ where, onOpenChange }: ConnectMachineDialogProps) {
  return (
    <Dialog open={where !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="connect-machine-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Connect {where}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>This machine is not connected to the hub, so it cannot be opened from here.</Trans>
          </DialogDescription>
        </DialogHeader>
        <ol className="flex list-decimal flex-col gap-3 ps-5 text-sm">
          <li>
            <Trans>
              On <strong data-testid="connect-machine-host">{where}</strong>, open a terminal.
            </Trans>
          </li>
          <li>
            <Trans>Run:</Trans>
            <div className="mt-1.5" data-testid="connect-machine-command">
              <CopyableCommand command={CONNECT_COMMAND} />
            </div>
          </li>
          <li>
            <Trans>Leave it running. This card turns Running by itself once the machine connects.</Trans>
          </li>
        </ol>
      </DialogContent>
    </Dialog>
  );
}
