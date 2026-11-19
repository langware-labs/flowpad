import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { FirstAgentCard } from '@src/pages/hub-home/first-agent/FirstAgentCard';

/** New → Agent: the "make an agent" wizard, in a dialog. */
export function MakeAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl" data-testid="make-agent-dialog">
        <DialogHeader className="sr-only">
          <DialogTitle>
            <Trans>Make an agent</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Pick where you will talk to it, describe it, and launch it.</Trans>
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: leaving before the agent is live removes what the wizard started. */}
        {open && <FirstAgentCard />}
      </DialogContent>
    </Dialog>
  );
}
