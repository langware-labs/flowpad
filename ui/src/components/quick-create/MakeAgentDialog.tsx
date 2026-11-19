import { Agent } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { lazy, Suspense } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useCloudAuthed } from '@src/hooks/use-cloud-authed';
import { FirstAgentCard } from '@src/pages/hub-home/first-agent/FirstAgentCard';

// Lazy: the name form reads the registry, and the registry names this dialog.
const NameDialog = lazy(() => import('./QuickCreateDialog').then((m) => ({ default: m.QuickCreateDialog })));

/**
 * New → Agent: the "make an agent" wizard, in a dialog. The wizard is answered by the hub, so a
 * signed-out desktop keeps the name form.
 */
export function MakeAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const signedIn = useCloudAuthed();
  if (!signedIn) {
    return (
      <Suspense fallback={null}>
        <NameDialog open={open} onOpenChange={onOpenChange} type={Agent.type} />
      </Suspense>
    );
  }
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
