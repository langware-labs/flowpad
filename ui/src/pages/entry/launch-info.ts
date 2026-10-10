import type { GitOrigin, HubRepoOrigin, ProjectSubkind } from '@sdk';
import apiClient from '@sdk/client';
import { useCallback, useEffect, useState } from 'react';

/**
 * What the hub knows about a launch link's id — `GET <agent|project>/<id>/launch_info`.
 *
 * One read answers what the launch page needs before anything is cloned: the project the id
 * belongs to (an agent's own project), where it is checked out from, and what it is for. A
 * `controller` project needs a target picked; any other opens as itself.
 */
export interface LaunchInfo {
  project_id: string | null;
  project_name: string;
  origin: GitOrigin | HubRepoOrigin | null;
  subkind: ProjectSubkind;
  home_page: string | null;
  agent_id: string | null;
  /** False when the agent is readable to this person but its project is not: nothing can be
   *  checked out for them. Absent from a hub that does not say — read as shared. */
  project_shared?: boolean;
}

export type LaunchInfoKind = 'agent' | 'project';

export function fetchLaunchInfo(kind: LaunchInfoKind, id: string): Promise<LaunchInfo | null> {
  return apiClient.get<LaunchInfo | null>(`/api/v1/graph/${kind}/${encodeURIComponent(id)}/launch_info`);
}

type LaunchInfoRead = { info: LaunchInfo | null; loading: boolean; error: unknown };

export interface LaunchInfoState extends LaunchInfoRead {
  /** Ask the hub again — after a failed read, or once the person has signed in again. */
  reload: () => void;
}

const IDLE: LaunchInfoRead = { info: null, loading: false, error: null };

/** `fetchLaunchInfo`, keyed on the id: a result for a previous id is never returned for this one. */
export function useLaunchInfo(kind: LaunchInfoKind, id: string | null, enabled: boolean): LaunchInfoState {
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const key = enabled && id ? `${kind}:${id}:${attempt}` : null;
  const [loaded, setLoaded] = useState<{ key: string; state: LaunchInfoRead } | null>(null);
  useEffect(() => {
    if (!key || !id) return;
    let cancelled = false;
    fetchLaunchInfo(kind, id)
      .then((info) => !cancelled && setLoaded({ key, state: { info, loading: false, error: null } }))
      .catch((error: unknown) => !cancelled && setLoaded({ key, state: { info: null, loading: false, error } }));
    return () => {
      cancelled = true;
    };
  }, [key, kind, id]);
  if (!key) return { ...IDLE, reload };
  return loaded?.key === key ? { ...loaded.state, reload } : { ...IDLE, loading: true, reload };
}
