import type { GitOrigin, HubRepoOrigin, ProjectSubkind } from '@sdk';
import apiClient from '@sdk/client';
import { useEffect, useState } from 'react';

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
}

export type LaunchInfoKind = 'agent' | 'project';

export function fetchLaunchInfo(kind: LaunchInfoKind, id: string): Promise<LaunchInfo | null> {
  return apiClient.get<LaunchInfo | null>(`/api/v1/graph/${kind}/${encodeURIComponent(id)}/launch_info`);
}

export interface LaunchInfoState {
  info: LaunchInfo | null;
  loading: boolean;
  error: unknown;
}

const IDLE: LaunchInfoState = { info: null, loading: false, error: null };

/** `fetchLaunchInfo`, keyed on the id: a result for a previous id is never returned for this one. */
export function useLaunchInfo(kind: LaunchInfoKind, id: string | null, enabled: boolean): LaunchInfoState {
  const key = enabled && id ? `${kind}:${id}` : null;
  const [loaded, setLoaded] = useState<{ key: string; state: LaunchInfoState } | null>(null);
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
  if (!key) return IDLE;
  return loaded?.key === key ? loaded.state : { ...IDLE, loading: true };
}
