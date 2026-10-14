import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import type { ComponentProps } from 'react';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

const STATUS_POLL_MS = 10_000;

/**
 * One line above a running app: is it up, on which port, and what a person does to it —
 * Restart, Stop, and its log. Read from the project's own `app-ports` (the same answer `flow app ports` prints),
 * so the screen and the CLI never disagree about whether an app is running.
 */
export function AppStatusLine({ projectId, app }: { projectId: string; app: string }) {
  const client = useQueryClient();
  const { navigation } = useDockNavigation();
  const key = ['app-ports', projectId];
  const { data: rows = [] } = useQuery({
    queryKey: key,
    queryFn: () => Project.appPorts(projectId),
    refetchInterval: STATUS_POLL_MS,
    staleTime: STATUS_POLL_MS,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const page = rows.find((row) => row.app === app && row.process === 'page') ?? rows.find((row) => row.app === app);
  if (!page) return null;

  const act = async (restart: boolean) => {
    setBusy(true);
    setProblem('');
    try {
      const answer = await Project.stopApp(projectId, app, restart);
      if (!answer.ok) setProblem(answer.detail);
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey: key });
    }
  };
  const up = page.state === 'running';

  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-3 py-1 text-xs" data-testid="app-status-line">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn('size-2 rounded-full', up ? 'bg-green-500' : page.state === 'conflict' ? 'bg-red-500' : 'bg-muted-foreground')}
        />
        <span className="font-medium">{app}</span>
        <span data-testid="app-status-state">{up ? <Trans>running</Trans> : page.state}</span>
      </span>
      {page.port ? <span className="text-muted-foreground" data-testid="app-status-port">:{page.port}</span> : null}
      {page.note || problem ? <span className="text-muted-foreground">{problem || page.note}</span> : null}
      <span className="ms-auto flex gap-1">
        <LineButton disabled={busy} onClick={() => void act(true)}>
          <Trans>Restart</Trans>
        </LineButton>
        {up ? (
          <LineButton disabled={busy} onClick={() => void act(false)}>
            <Trans>Stop</Trans>
          </LineButton>
        ) : null}
        {page.log ? (
          <LineButton onClick={() => navigation.openFile(page.log!)}>
            <Trans>Logs</Trans>
          </LineButton>
        ) : null}
      </span>
    </div>
  );
}

function LineButton(props: ComponentProps<typeof Button>) {
  return <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" {...props} />;
}
