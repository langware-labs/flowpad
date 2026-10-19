import { Deployment, WebApp } from '@sdk';
import { useEntitiesQuery, useProject } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { appsQuery } from '@src/hooks/flow-hooks/useAssetApps';
import { useMemo } from 'react';
import { ALL_DEPLOYMENTS, DeploymentBadges, deploymentsByParent, runningRows } from './agent-counters';
import type { AssetCounter, AssetCounterGroup } from './types';

/** An app plus the placements that make it "running". */
export interface AppRow {
  app: WebApp;
  deployments: Deployment[];
}

const EMPTY_APPS: WebApp[] = [];
const EMPTY_DEPLOYMENTS: Deployment[] = [];

function useAppCounters(): AssetCounter<AppRow>[] {
  const { project } = useProject(null);
  const { data: apps = EMPTY_APPS, isLoading: appsLoading } = useEntitiesQuery<WebApp>(appsQuery);
  const { data: deployments = EMPTY_DEPLOYMENTS, isLoading: deploymentsLoading } =
    useEntitiesQuery<Deployment>(ALL_DEPLOYMENTS);

  const allRows = useMemo(() => {
    const byApp = deploymentsByParent(deployments, WebApp.type);
    return [...apps]
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .map((app) => ({ app, deployments: byApp.get(app.typeId.toString()) ?? [] }));
  }, [apps, deployments]);
  const projectId = project?.id;
  const projectRows = useMemo(
    () => (projectId ? allRows.filter((row) => row.app.project_id === projectId) : []),
    [allRows, projectId],
  );

  return useMemo(() => {
    const projectName = project?.name || <Trans>Project</Trans>;
    return [
      {
        key: 'running',
        label: <Trans>Running</Trans>,
        description: <Trans>Apps in {projectName} with a deployment</Trans>,
        items: runningRows(projectRows),
        isLoading: appsLoading || deploymentsLoading,
      },
      {
        key: 'project',
        label: projectName,
        description: <Trans>Every app in {projectName}</Trans>,
        items: projectRows,
        isLoading: appsLoading,
      },
      {
        key: 'total',
        label: <Trans>Total</Trans>,
        description: <Trans>Every app on this machine</Trans>,
        items: allRows,
        isLoading: appsLoading,
      },
    ];
  }, [project?.name, projectRows, allRows, appsLoading, deploymentsLoading]);
}

export const appCounterGroup: AssetCounterGroup<AppRow> = {
  id: 'apps',
  type: WebApp.type,
  useCounters: useAppCounters,
  itemKey: (row) => row.app.id,
  searchText: ({ app, deployments }) =>
    [app.name, app.description, app.kind, ...deployments.map((d) => d.target.provider)].filter(Boolean).join(' '),
  itemPointer: (row) => row.app.dockPointer,
  columns: [
    {
      key: 'app',
      header: <Trans>App</Trans>,
      cell: ({ app }) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{app.name}</div>
          {app.description && <div className="truncate text-xs text-muted-foreground">{app.description}</div>}
        </div>
      ),
      className: 'w-[45%] max-w-0',
    },
    {
      key: 'kind',
      header: <Trans>Kind</Trans>,
      cell: ({ app }) => <span className="text-muted-foreground">{app.kind}</span>,
    },
    {
      key: 'deployments',
      header: <Trans>Deployments</Trans>,
      cell: ({ deployments }) => <DeploymentBadges deployments={deployments} />,
    },
  ],
};
