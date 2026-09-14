import { Deployment } from '@sdk';
import apiClient from '@sdk/client';
import { useOnTag } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { RunRow, type RunSummary } from '@src/components/runs/RunRow';
import { scopeQuery } from '@src/components/runs/RunsView';
import '@src/components/runs/runs.css';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

const RECENT = 8;

/**
 * The latest runs and chats on one place. Opening one goes to the run history.
 *
 * This computer's runs are the local run list; a cloud machine's live in its own
 * database, read through the hub.
 */
export function AgentPlaceActivity({ deployment, isLocal = true }: { deployment: Deployment; isLocal?: boolean }) {
  const { navigation } = useDockNavigation();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    try {
      if (isLocal) {
        const data: { runs?: RunSummary[] } | null = await apiClient.get(
          `/runs?limit=${RECENT}${scopeQuery({ deployment_id: deployment.id })}`,
        );
        setRuns(data?.runs ?? []);
      } else {
        setRuns(await deployment.runs<RunSummary>(RECENT));
      }
      setUnreachable(false);
    } catch {
      setRuns([]);
      setUnreachable(!isLocal);
    }
  }, [deployment, isLocal]);

  useEffect(() => {
    void load();
  }, [load]);
  // A run starting or finishing should appear without a refresh.
  // Only this computer's runs are on the local bus; a cloud machine's are not.
  useOnTag('agent.status', () => {
    if (isLocal) void load();
  });

  if (runs === null) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="agent-place-activity">
      {unreachable ? (
        <p className="text-xs text-muted-foreground" data-testid="agent-place-activity-unreachable">
          <Trans>Could not reach this cloud machine. It may be paused.</Trans>
        </p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="agent-place-no-activity">
          <Trans>Nothing has run here yet.</Trans>
        </p>
      ) : (
        <ol className="runs-rows">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              active={false}
              onSelect={() =>
                navigation.openDock(DockPointer.forProcessRuns({ deployment_id: deployment.id, run: run.id }))
              }
            />
          ))}
        </ol>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigation.openDock(DockPointer.forProcessRuns({ deployment_id: deployment.id }))}
          data-testid="agent-place-all-runs"
        >
          <Trans>All runs</Trans>
        </Button>
      </div>
    </div>
  );
}
