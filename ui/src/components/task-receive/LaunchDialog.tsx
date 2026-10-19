import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { Button } from '@src/components/ui/button';
import { StepList } from '@src/components/ui/step-list';
import type { Step } from '@src/hooks/use-step-flow';
import { errorMessage, isUnfundedHarness } from '@src/lib/error-message';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useProjects } from '@src/hooks/use-projects';
import { useActiveWorkspace } from '@src/hooks/use-workspaces';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LaunchFailure, type LaunchStep, runLaunch } from '@src/pages/entry/launch-runner';
import { openProjectSetup } from '@src/components/project-setup/project-setup-store';
import { RuntimeStrip } from '@src/components/top-nav-bar/RuntimeStrip';
import type { LaunchPlan } from '@src/pages/entry/launch-plan';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

const ORDER: LaunchStep[] = ['controller', 'target', 'setup', 'session'];

/**
 * The SETUP stage of a launch link, on screen: the steps `runLaunch` walks, then the session.
 *
 * No confirm step — the link was the confirmation, made on the hub page that sent it here.
 * Runs once per plan (StrictMode replays the effect). A launch that stops says at which step and
 * why, and can be run again from here: the link's parameters are already gone from the URL.
 * The band on top is the machine this is happening on.
 *
 * One question can come first: a controller sent here without a target works on a project that is
 * only on this machine, so the person picks it here. That project is used where it is — the
 * cloud never sees it.
 */
export function LaunchDialog({ plan: asked, onClose }: { plan: LaunchPlan; onClose: () => void }) {
  const { t } = useLingui();
  const { computeNode } = useAgentContext();
  const { scopeId: workspaceId } = useActiveWorkspace();
  const { navigation } = useDockNavigation();
  const [plan, setPlan] = useState(asked);
  const needsPick = 'local' in plan.target && plan.target.local === null;
  const { projects = [] } = useProjects({ enabled: needsPick });
  const local = projects.filter((p) => p.id !== plan.controllerId && p.fs_storage_mount_path);
  const order = ORDER.filter((s) => plan.controllerId || (s !== 'controller' && s !== 'setup'));
  const [step, setStep] = useState<LaunchStep>(order[0]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const launch = useCallback(() => {
    setError(null);
    void runLaunch(plan, {
      computeNodeId: computeNode?.id ?? null,
      workspaceId,
      onStep: setStep,
      onNeedsSetup: (controller) =>
        openProjectSetup({ projectId: String(controller.id), projectName: controller.name ?? '' }),
    })
      .then((dock) => {
        onClose();
        navigation.openDock(dock);
      })
      .catch((e: unknown) => {
        const cause = e instanceof LaunchFailure ? e.cause : e;
        if (e instanceof LaunchFailure) setStep(e.step);
        setError(
          isUnfundedHarness(cause)
            ? t`This machine has no model to run the agent on. Set one up, then try again.`
            : errorMessage(cause, t`Couldn't launch.`),
        );
      });
  }, [plan, computeNode, workspaceId, navigation, onClose, t]);

  useEffect(() => {
    if (started.current || needsPick) return;
    started.current = true;
    launch();
  }, [launch, needsPick]);

  const labels: Record<LaunchStep, string> = {
    controller: t`Getting the controller project`,
    target: t`Getting the project to work on`,
    setup: t`Setting up the controller`,
    session: t`Starting the session`,
  };
  const current = order.indexOf(step);
  const steps: Step<LaunchStep>[] = order.map((id, i) => ({
    id,
    label: labels[id],
    status: i < current ? 'success' : i > current ? 'idle' : error ? 'error' : 'loading',
  }));

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        hideClose
        className="max-w-md overflow-hidden"
        data-testid="launch-dialog"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <RuntimeStrip className="-mx-6 -mt-6" />
        <DialogHeader>
          <DialogTitle data-testid="launch-dialog-title">
            {needsPick ? (
              <Trans>Which project should it work on?</Trans>
            ) : error ? (
              <Trans>Couldn't launch</Trans>
            ) : (
              <Trans>Launching…</Trans>
            )}
          </DialogTitle>
          <DialogDescription>
            {needsPick ? (
              <Trans>Pick a project on this machine. It is used where it is — nothing is sent to the cloud.</Trans>
            ) : (
              <Trans>Checking out the projects and opening the session.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        {needsPick ? (
          <div className="space-y-3">
            {local.length ? (
              <ul className="max-h-64 space-y-1 overflow-y-auto" data-testid="launch-local-projects">
                {local.map((p) => (
                  <li key={p.id}>
                    <Button
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => setPlan({ ...plan, target: { local: String(p.id) } })}
                      data-testid={`launch-local-${p.id}`}
                    >
                      {p.name}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="launch-local-none">
                <Trans>There are no projects on this machine yet. Open one, then use the link again.</Trans>
              </p>
            )}
            <Button variant="ghost" onClick={onClose} data-testid="launch-close">
              <Trans>Close</Trans>
            </Button>
          </div>
        ) : (
          <StepList steps={steps} testIdPrefix="launch" />
        )}
        {error && (
          <div className="space-y-3">
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
              data-testid="launch-error"
            >
              {error}
            </p>
            <div className="flex gap-2">
              <Button onClick={launch} data-testid="launch-retry">
                <Trans>Try again</Trans>
              </Button>
              <Button variant="ghost" onClick={onClose} data-testid="launch-close">
                <Trans>Close</Trans>
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
