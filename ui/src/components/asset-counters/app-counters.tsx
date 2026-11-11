import { Deployment, WebApp } from '@sdk';
import { useEntitiesQuery, useProject } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { appsQuery } from '@src/hooks/flow-hooks/useAssetApps';
import { useMemo } from 'react';
import { ALL_DEPLOYMENTS, DeploymentBadges, deploymentsByProject } from './agent-counters';
import { crossCounters, useScopes } from './axes';
import { isPaused, isRunning, runPauseStatuses } from './placement';
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
    // An app runs wherever its project is deployed: a deployment places the whole project.
    const byProject = deploymentsByProject(deployments);
    return [...apps]
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .map((app) => ({ app, deployments: (app.project_id && byProject.get(app.project_id)) || [] }));
  }, [apps, deployments]);
  const projectId = project?.id;
  const projectRows = useMemo(
    () => (projectId ? allRows.filter((row) => row.app.project_id === projectId) : []),
    [allRows, projectId],
  );

  const scopes = useScopes(
    { items: allRows, isLoading: appsLoading },
    { items: projectRows, isLoading: appsLoading },
    appCreator,
  );
  return useMemo(
    () =>
      crossCounters({
        label: <Trans>Apps</Trans>,
        scopes,
        statuses: runPauseStatuses<AppRow>(isRunning, isPaused, deploymentsLoading),
      }),
    [scopes, deploymentsLoading],
  );
}

const appCreator = (row: AppRow) => row.app.created_by;

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
