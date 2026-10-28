import { Project, type ProjectAppPort } from '@sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

/** The same query, key and period `AppStatusLine` reads: one process-table walk serves every open view. */
const POLL_MS = 10_000;

export interface AppRunState {
  /** Each process of the app here (`page`, or a service's name); null until the first read. */
  rows: ProjectAppPort[] | null;
  /** What the running processes no longer match in the saved definition — a restart applies them. */
  changes: string[];
  running: boolean;
  /** The process that cannot start because its required port is held, if any. */
  conflict: ProjectAppPort | null;
  busy: boolean;
  /** Stop the app and start it again from the saved definition; resolves with the backend's word. */
  restart: () => Promise<{ ok: boolean; detail: string }>;
  reload: () => void;
}

/** The app's processes on this computer (`GET project/<id>/app-ports`), and Restart (`app-stop` + restart). */
export function useAppRunState(projectId: string | null | undefined, appName: string, enabled: boolean): AppRunState {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const key = useMemo(() => ['app-ports', projectId ?? ''], [projectId]);
  const { data: all } = useQuery({
    queryKey: key,
    queryFn: () => Project.appPorts(projectId!),
    enabled: enabled && !!projectId,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });

  const reload = useCallback(() => void client.invalidateQueries({ queryKey: key }), [client, key]);

  const restart = useCallback(async () => {
    if (!projectId) return { ok: false, detail: 'This app has no project.' };
    setBusy(true);
    try {
      return await Project.stopApp(projectId, appName, true);
    } finally {
      setBusy(false);
      reload();
    }
  }, [appName, projectId, reload]);

  return useMemo(() => {
    const rows = all ? all.filter((row) => row.app === appName) : null;
    const changes = (rows ?? []).flatMap((row) =>
      (row.changes ?? []).map((change) => (row.process === 'page' ? change : `${row.process}: ${change}`)),
    );
    return {
      rows,
      changes,
      running: (rows ?? []).some((row) => row.state === 'running' || row.state === 'wrong_port'),
      conflict: (rows ?? []).find((row) => row.state === 'conflict') ?? null,
      busy,
      restart,
      reload,
    };
  }, [all, appName, busy, reload, restart]);
}
