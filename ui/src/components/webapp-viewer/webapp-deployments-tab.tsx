import { Trans } from '@lingui/react/macro';
import { KIND_WEB, WorldViewProjection } from '@sdk';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useCurrentDeployments } from '@src/hooks/flow-hooks';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { Cloud, Loader2 } from 'lucide-react';
import React from 'react';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';

const STATUS_COLOR = {
  current: 'bg-green-500',
  stale: 'bg-amber-400',
  partial: 'bg-orange-500',
  error: 'bg-red-500',
} as const;

/** Read-only placement summary; full hierarchy and properties live in WorldView. */
export const WebappDeploymentsTab: React.FC = () => {
  const { data: allDeployments = [], isLoading, project } = useCurrentDeployments();
  const { navigation } = useDockNavigation();
  const [deploying, setDeploying] = React.useState(false);

  /**
   * Put this app on a machine of its own in the cloud.
   *
   * Deploying the PROJECT, because the project is what has the repository the
   * sandbox materializes — and it is what a local web placement already parents
   * to, so both tiers agree on what a web deployment hangs off.
   */
  const deploy = React.useCallback(async () => {
    if (!project) return;
    setDeploying(true);
    try {
      const result = await project.deploy();
      notify.success({
        title: result.reused ? 'Already deployed' : 'Deployed to the cloud',
        message: result.host_url ?? undefined,
      });
    } catch (e) {
      notify.error({
        title: 'Could not deploy',
        message: e instanceof Error ? e.message : 'Deploy failed.',
      });
    } finally {
      setDeploying(false);
    }
  }, [project]);

  const deployButton = (
    <Button size="sm" disabled={!project || deploying} onClick={() => void deploy()}>
      {deploying ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" /> : <Cloud className="me-1.5 h-3.5 w-3.5" />}
      <Trans>Deploy to cloud</Trans>
    </Button>
  );

  // WEB placements only. Every placement is now ONE entity, so without this the
  // web-app viewer would also list an agent's sandbox and a cloud desktop.
  // Prefix match, not equality: the ontology is hierarchical, and a row refined
  // to `runtime.web.vite` is still a web runtime.
  const deployments = React.useMemo(
    () => allDeployments.filter((d) => d.kind === KIND_WEB || d.kind.startsWith(`${KIND_WEB}.`)),
    [allDeployments],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading deployments…</Trans>
      </div>
    );
  }

  if (deployments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Cloud className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p className="mb-3">
            <Trans>No deployments observed yet</Trans>
          </p>
          {deployButton}
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex justify-end px-3 pt-3">{deployButton}</div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {deployments.map((deployment) => (
          <button
            type="button"
            key={deployment.id}
            className="rounded-md border p-3 text-start transition-colors hover:bg-muted"
            onClick={() =>
              navigation.openDock(
                DockPointer.forWorldView(WorldViewProjection.DEPLOYMENT, {
                  focus: deployment.typeId,
                  selected: deployment.typeId.toString(),
                }),
              )
            }
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[deployment.status.sync_state]}`} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{deployment.displayName}</span>
              <span className="text-xs text-muted-foreground">{deployment.status.sync_state}</span>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{deployment.kind}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{deployment.target.scope}</p>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
};
