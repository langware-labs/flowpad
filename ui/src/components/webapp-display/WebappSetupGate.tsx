import { useQueryClient } from '@tanstack/react-query';
import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useSetupRun } from '@src/components/project-setup/use-setup-run';
import { SetupTreeView } from '@src/components/project-setup/SetupTreeView';
import { WebappSetupOverlay } from './WebappSetupOverlay';

/**
 * A web app whose dev server does not answer (stopped, or never started): what the app view shows instead
 * of "no running dev server". It runs the app's own node of the project's setup tree once (what the app
 * needs, then install → build → start) with the live tree on screen, then re-resolves the app's address —
 * the app takes over as soon as it answers. A setup that could not bring it up stays on screen with why.
 */
export function WebappSetupGate({ projectId, webappId }: { projectId: string; webappId: string }) {
  const queryClient = useQueryClient();
  const setup = useSetupRun(
    projectId,
    `micro_app-${webappId}`,
    async () => {
      // The dev server's address is resolved once and cached; a server that just came up has a new answer.
      await queryClient.invalidateQueries({ queryKey: ['service_endpoint'] });
    },
    { autoStart: true },
  );

  const failed = !setup.running && setup.tree !== null && setup.tree.state !== 'done' && setup.tree.state !== 'running';
  if (failed) {
    return (
      <div className="flex h-full w-full items-start justify-center overflow-auto bg-background p-8" data-testid="webapp-setup-failed">
        <div className="flex w-full max-w-xl flex-col gap-4">
          <h2 className="text-lg font-semibold">
            <Trans>This app could not be set up</Trans>
          </h2>
          <SetupTreeView tree={setup.tree} />
          <div>
            <Button data-testid="webapp-setup-retry" onClick={() => void setup.start()}>
              <Trans>Set up again</Trans>
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return <WebappSetupOverlay tree={setup.tree} questionId={setup.questionId} onQuestionSettled={setup.settleQuestion} />;
}
