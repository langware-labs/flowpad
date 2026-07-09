import { useCallback, useMemo, useRef } from 'react';
import type { Project, ProjectSecretOriginSummary, SecretPointerScope } from '@sdk';

export function useProjectSecretOrigins(project: Project | null | undefined) {
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project ?? null;

  const secretOrigins = useMemo<ProjectSecretOriginSummary[]>(
    () => (project?.secret_origins ?? []).filter((s): s is ProjectSecretOriginSummary => !!s?.typeid),
    [project?.secret_origins],
  );

  const addLocalPointer = useCallback(async (
    sodName: string,
    envVar: string,
    name?: string,
  ) => {
    const p = projectRef.current;
    if (!p || !sodName || !envVar) return;
    await p.addSecretPointer(name || sodName, envVar, {
      scope: 'private',
      locator: { kind: 'local', sod_name: sodName },
    });
  }, []);

  const addHubPointer = useCallback(async (
    secretId: string,
    envVar: string,
    name?: string,
    scope: SecretPointerScope = 'shared',
  ) => {
    const p = projectRef.current;
    if (!p || !secretId || !envVar) return;
    await p.addSecretPointer(name || secretId, envVar, {
      scope,
      locator: { kind: 'flowpad-hub', secret_id: secretId },
    });
  }, []);

  const remove = useCallback(async (typeid: string) => {
    const p = projectRef.current;
    if (!p || !typeid) return;
    await p.removeSecretPointer(typeid);
  }, []);

  return { secretOrigins, addLocalPointer, addHubPointer, remove } as const;
}
