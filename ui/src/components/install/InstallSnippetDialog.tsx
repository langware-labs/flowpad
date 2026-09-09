import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { CopyableCommand } from '@src/components/version-popover/version-popover';

/**
 * The lines that turn a machine into a logged-in desktop and install the asset
 * there: the last one is the shell form of the Install button, running the
 * same desk code the Add-asset dialog does.
 */
function installSnippet(typeid: string): string[] {
  return ['uv tool install flowpad', 'flow start', 'flow auth login', `flow asset install ${typeid}`];
}

/**
 * Shown on the hub when Install found no logged-in desktop to send to.
 * Copyable line by line, or all at once.
 */
export function InstallSnippetDialog({
  open,
  onOpenChange,
  typeid,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  typeid: string;
}) {
  const lines = installSnippet(typeid);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="install-snippet-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Install Flowpad on your computer first</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>No logged-in desktop was found. Paste these lines into a terminal — the last one installs the asset.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {lines.map((line) => (
            <CopyableCommand key={line} command={line} />
          ))}
          <CopyableCommand command={lines.join(' && ')} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
