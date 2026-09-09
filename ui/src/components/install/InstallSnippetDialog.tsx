import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { CopyableCommand } from '@src/components/version-popover/version-popover';

/** The three lines that turn a machine into a logged-in desktop. */
export const INSTALL_SNIPPET = ['uv tool install flowpad', 'flow start', 'flow auth login'] as const;

/**
 * Shown on the hub when Install found no logged-in desktop to send to.
 * Copyable line by line, or all at once.
 */
export function InstallSnippetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="install-snippet-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Install Flowpad on your computer first</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>No logged-in desktop was found. Run these three lines, then click Install again.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {INSTALL_SNIPPET.map((line) => (
            <CopyableCommand key={line} command={line} />
          ))}
          <CopyableCommand command={INSTALL_SNIPPET.join(' && ')} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
