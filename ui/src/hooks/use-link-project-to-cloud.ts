import { useCallback, useRef, useState } from 'react';
import type { Project } from '@sdk';
import { useCloudLoginGate } from './use-cloud-login-gate';

/** The same canonical cloud-link action for Project Home and sharing. */
export function useLinkProjectToCloud() {
  const requireCloudLogin = useCloudLoginGate();
  const pending = useRef<Map<string, Promise<Project>>>(new Map());
  const [linking, setLinking] = useState(false);
  const linkProject = useCallback(
    (project: Project): Promise<Project> => {
      if (project.remote === true) return Promise.resolve(project);
      const key = project.id;
      const existing = pending.current.get(key);
      if (existing) return existing;
      setLinking(true);
      const operation = (async () => {
        const login = await requireCloudLogin();
        if (!login.ok) throw new Error(login.error);
        const canonical = await project.share();
        if (canonical.remote !== true) throw new Error('The server did not confirm the cloud link.');
        return canonical;
      })().finally(() => {
        pending.current.delete(key);
        setLinking(pending.current.size > 0);
      });
      pending.current.set(key, operation);
      return operation;
    },
    [requireCloudLogin],
  );
  return { linkProject, linking };
}
