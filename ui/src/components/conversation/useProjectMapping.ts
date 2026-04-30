import { useCallback, useEffect, useState } from 'react';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { dataManager } from '@sdk';

export type ProjectMapping = Record<string, string>;

let _cache: ProjectMapping | null = null;
let _loading: Promise<ProjectMapping> | null = null;
const _listeners = new Set<(m: ProjectMapping) => void>();

function notify() {
  if (_cache) _listeners.forEach((cb) => cb(_cache!));
}

async function fetchMapping(): Promise<ProjectMapping> {
  const action = new ActionInfo('get-project-mapping', null, null, 'GET');
  const res = await dataManager.callAction<undefined, { mapping: ProjectMapping }>(action);
  return res?.mapping ?? {};
}

function ensureLoaded(): Promise<ProjectMapping> {
  if (_cache) return Promise.resolve(_cache);
  if (_loading) return _loading;
  _loading = fetchMapping().then((m) => {
    _cache = m;
    _loading = null;
    notify();
    return m;
  });
  return _loading;
}

/**
 * Module-level mapping write — usable from anywhere (apply-project-choice,
 * the gate's auto-persist effect). Keeps the shared in-memory cache in sync
 * so other subscribers (e.g. the gate hook) see the new mapping immediately
 * without waiting for a re-fetch.
 */
export async function writeProjectMapping(
  remoteProjectId: string,
  localProjectId: string,
): Promise<ProjectMapping> {
  const action = new ActionInfo('set-project-mapping', null, null, 'POST');
  action.bodyParameters = { remote_project_id: remoteProjectId, local_project_id: localProjectId };
  const res = await dataManager.callAction<
    { remote_project_id: string; local_project_id: string },
    { mapping: ProjectMapping }
  >(action);
  _cache = res?.mapping ?? { ...(_cache ?? {}), [remoteProjectId]: localProjectId };
  notify();
  return _cache;
}

export function useProjectMapping(): {
  mapping: ProjectMapping;
  loaded: boolean;
  setMapping: (remoteProjectId: string, localProjectId: string) => Promise<void>;
} {
  const [mapping, setLocal] = useState<ProjectMapping>(_cache ?? {});
  const [loaded, setLoaded] = useState<boolean>(_cache !== null);

  useEffect(() => {
    _listeners.add(setLocal);
    void ensureLoaded().then(() => setLoaded(true));
    return () => { _listeners.delete(setLocal); };
  }, []);

  const setMapping = useCallback(async (remoteProjectId: string, localProjectId: string) => {
    await writeProjectMapping(remoteProjectId, localProjectId);
  }, []);

  return { mapping, loaded, setMapping };
}
