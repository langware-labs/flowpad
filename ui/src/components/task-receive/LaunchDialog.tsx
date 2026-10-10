import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { Button } from '@src/components/ui/button';
import { StepList } from '@src/components/ui/step-list';
import type { Step } from '@src/hooks/use-step-flow';
import { errorMessage } from '@src/lib/error-message';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useActiveWorkspace } from '@src/hooks/use-workspaces';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { type LaunchStep, runLaunch } from '@src/pages/entry/launch-runner';
import type { LaunchPlan } from '@src/pages/entry/launch-plan';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

const ORDER: LaunchStep[] = ['controller', 'target', 'setup', 'session'];

/**
 * The SETUP stage of a launch link, on screen: the steps `runLaunch` walks, then the session.
 *
 * No confirm step — the link was the confirmation, made on the hub page that sent it here.
 * Runs once per plan (StrictMode replays the effect); only its own button closes it.
 */
export function LaunchDialog({ plan, onClose }: { plan: LaunchPlan; onClose: () => void }) {
  const { t } = useLingui();
  const { computeNode } = useAgentContext();
  const { scopeId: workspaceId } = useActiveWorkspace();
  const { navigation } = useDockNavigation();
  const [step, setStep] = useState<LaunchStep>('controller');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runLaunch(plan, { computeNodeId: computeNode?.id ?? null, workspaceId, onStep: setStep })
      .then((dock) => {
        onClose();
        navigation.openDock(dock);
      })
      .catch((e: unknown) => setError(errorMessage(e, t`Couldn't launch.`)));
  }, [plan, computeNode, workspaceId, navigation, onClose, t]);

  const labels: Record<LaunchStep, string> = {
    controller: t`Getting the controller project`,
    target: t`Getting the project to work on`,
    setup: t`Setting up the controller`,
    session: t`Starting the session`,
  };
  const order = ORDER.filter((s) => plan.controllerId || (s !== 'controller' && s !== 'setup'));
  const current = order.indexOf(step);
  const steps: Step<LaunchStep>[] = order.map((id, i) => ({
    id,
    label: labels[id],
    status: i < current ? 'success' : i > current ? 'idle' : error ? 'error' : 'loading',
  }));

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent className="max-w-md" data-testid="launch-dialog" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Launching…</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Checking out the projects and opening the session.</Trans>
          </DialogDescription>
        </DialogHeader>
        <StepList steps={steps} testIdPrefix="launch" />
        {error && (
          <div className="space-y-3">
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
              data-testid="launch-error"
            >
              {error}
            </p>
            <Button variant="ghost" onClick={onClose}>
              <Trans>Close</Trans>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
