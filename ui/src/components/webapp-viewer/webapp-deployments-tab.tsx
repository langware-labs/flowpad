import { Trans } from '@lingui/react/macro';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useCurrentDeployments } from '@src/hooks/flow-hooks';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { Cloud } from 'lucide-react';
import React from 'react';

const STATUS_COLOR = {
  current: 'bg-green-500',
  stale: 'bg-amber-400',
  partial: 'bg-orange-500',
  error: 'bg-red-500',
} as const;

/** Read-only placement summary; full hierarchy and properties live in WorldView. */
export const WebappDeploymentsTab: React.FC = () => {
  const { data: deployments = [], isLoading } = useCurrentDeployments();
  const { navigation } = useDockNavigation();

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Trans>Loading deployments…</Trans></div>;
  }

  if (deployments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Cloud className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p><Trans>No deployments observed yet</Trans></p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {deployments.map((deployment) => (
          <button
            type="button"
            key={deployment.id}
            className="rounded-md border p-3 text-left transition-colors hover:bg-muted"
            onClick={() => navigation.openDock(
              DockPointer.forWorldView(deployment.typeId, { selected: deployment.typeId.toString() }),
            )}
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
